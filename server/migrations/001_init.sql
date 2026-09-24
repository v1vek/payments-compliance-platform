-- Meridian schema. All money is bigint cents. Rules that must hold no matter
-- which code path writes the row live here, not only in the application.

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE CHECK (email = lower(email)),
  name          text NOT NULL,
  role          text NOT NULL CHECK (role IN ('customer', 'compliance')),
  label         text NOT NULL,
  initials      text NOT NULL,
  password_hash text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL
);

CREATE TABLE accounts (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      uuid NOT NULL REFERENCES users(id),
  holder_name   text NOT NULL,
  masked_number text NOT NULL,
  currency      char(3) NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  -- ledger: booked balance. held: reserved for payments not yet sent.
  ledger_cents  bigint NOT NULL CHECK (ledger_cents >= 0),
  held_cents    bigint NOT NULL DEFAULT 0 CHECK (held_cents >= 0),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'closed')),
  opened_at     timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz,
  CONSTRAINT available_not_negative CHECK (held_cents <= ledger_cents)
);
CREATE UNIQUE INDEX one_active_account_per_owner ON accounts (owner_id) WHERE status = 'active';

CREATE TABLE sanctions_entries (
  id       serial PRIMARY KEY,
  name     text NOT NULL UNIQUE,
  added_at timestamptz NOT NULL DEFAULT now()
);

CREATE SEQUENCE payment_number_seq START 1039;

CREATE TABLE payments (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number             bigint NOT NULL UNIQUE DEFAULT nextval('payment_number_seq'),
  account_id         uuid NOT NULL REFERENCES accounts(id),
  created_by         uuid NOT NULL REFERENCES users(id),
  idempotency_key    text,
  recipient          text NOT NULL CHECK (length(btrim(recipient)) BETWEEN 1 AND 140),
  country            text NOT NULL,
  account_details    text NOT NULL,
  reference          text NOT NULL,
  amount_cents       bigint NOT NULL CHECK (amount_cents > 0),
  currency           char(3) NOT NULL DEFAULT 'USD',
  status             text NOT NULL CHECK (status IN ('screening', 'sent', 'on_hold', 'refused', 'rejected')),
  hold_reason        text CHECK (hold_reason IN ('threshold', 'sanctions_timeout', 'sanctions_match')),
  screening          jsonb,
  threshold_cents    bigint,
  window_prior_cents bigint,
  window_payment_ids uuid[],
  created_at         timestamptz NOT NULL DEFAULT now(),
  held_at            timestamptz,
  resolved_at        timestamptz,
  CONSTRAINT flagged_status_has_reason
    CHECK (status NOT IN ('on_hold', 'refused', 'rejected') OR hold_reason IS NOT NULL),
  CONSTRAINT idempotency_unique UNIQUE (created_by, idempotency_key)
);
CREATE INDEX payments_window_idx ON payments (account_id, created_at);

CREATE TABLE payment_reviews (
  payment_id          uuid PRIMARY KEY REFERENCES payments(id),
  recommended_by      uuid NOT NULL REFERENCES users(id),
  recommendation      text NOT NULL CHECK (recommendation IN ('release', 'reject')),
  recommendation_note text NOT NULL DEFAULT '',
  recommended_at      timestamptz NOT NULL DEFAULT now(),
  decided_by          uuid REFERENCES users(id),
  decision            text CHECK (decision IN ('release', 'reject')),
  decision_note       text,
  decided_at          timestamptz,
  -- Four-eyes: the recommender can never be the decider.
  CONSTRAINT four_eyes CHECK (decided_by IS NULL OR decided_by <> recommended_by),
  CONSTRAINT decision_complete CHECK (
    (decided_by IS NULL AND decision IS NULL AND decided_at IS NULL) OR
    (decided_by IS NOT NULL AND decision IS NOT NULL AND decided_at IS NOT NULL))
);

CREATE TABLE audit_events (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id   uuid REFERENCES users(id),
  actor_name text NOT NULL,
  action     text NOT NULL,
  detail     text NOT NULL,
  payment_id uuid REFERENCES payments(id),
  data       jsonb
);
CREATE INDEX audit_events_payment_idx ON audit_events (payment_id);

-- Audit history is append-only, even for the table owner.
CREATE FUNCTION audit_events_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_events_no_update BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION audit_events_immutable();

-- Payments: immutable core fields, legal status transitions only, and a held
-- payment can leave on_hold only after a completed two-person review.
CREATE FUNCTION payments_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  r payment_reviews%ROWTYPE;
BEGIN
  IF NEW.amount_cents <> OLD.amount_cents OR NEW.recipient <> OLD.recipient
     OR NEW.account_id <> OLD.account_id OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION 'payment % core fields are immutable', OLD.number;
  END IF;
  IF OLD.hold_reason IS NOT NULL AND NEW.hold_reason IS DISTINCT FROM OLD.hold_reason THEN
    RAISE EXCEPTION 'payment % hold_reason cannot change once set', OLD.number;
  END IF;
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD.status = 'screening' AND NEW.status IN ('sent', 'on_hold', 'refused')) OR
    (OLD.status = 'on_hold'   AND NEW.status IN ('sent', 'rejected', 'refused'))
  ) THEN
    RAISE EXCEPTION 'illegal payment transition % -> %', OLD.status, NEW.status;
  END IF;
  IF OLD.status = 'on_hold' THEN
    SELECT * INTO r FROM payment_reviews WHERE payment_id = OLD.id;
    IF NOT FOUND OR r.decided_by IS NULL THEN
      RAISE EXCEPTION 'payment % cannot leave on_hold without a final review decision', OLD.number;
    END IF;
    IF (NEW.status = 'rejected' AND r.decision <> 'reject')
       OR (NEW.status IN ('sent', 'refused') AND r.decision <> 'release') THEN
      RAISE EXCEPTION 'payment % transition to % does not match decision %', OLD.number, NEW.status, r.decision;
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payments_guard BEFORE UPDATE ON payments
  FOR EACH ROW EXECUTE FUNCTION payments_guard();
CREATE TRIGGER payments_no_delete BEFORE DELETE ON payments
  FOR EACH ROW EXECUTE FUNCTION audit_events_immutable();

-- Reviews: a recommendation and a decision are each written once.
CREATE FUNCTION payment_reviews_write_once() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_reviews rows cannot be deleted';
  END IF;
  IF NEW.recommended_by <> OLD.recommended_by OR NEW.recommendation <> OLD.recommendation
     OR NEW.recommendation_note <> OLD.recommendation_note OR NEW.recommended_at <> OLD.recommended_at THEN
    RAISE EXCEPTION 'recommendation cannot be changed once recorded';
  END IF;
  IF OLD.decided_by IS NOT NULL THEN
    RAISE EXCEPTION 'decision cannot be changed once recorded';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_reviews_write_once BEFORE UPDATE OR DELETE ON payment_reviews
  FOR EACH ROW EXECUTE FUNCTION payment_reviews_write_once();

-- Least-privilege app role, when the host supports a separate role.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'meridian_app') THEN
    GRANT USAGE ON SCHEMA public TO meridian_app;
    GRANT SELECT ON users, sanctions_entries TO meridian_app;
    GRANT SELECT, INSERT, DELETE ON sessions TO meridian_app;
    GRANT SELECT, INSERT, UPDATE ON accounts, payments, payment_reviews TO meridian_app;
    GRANT SELECT, INSERT ON audit_events TO meridian_app;
    GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO meridian_app;
  END IF;
END $$;
