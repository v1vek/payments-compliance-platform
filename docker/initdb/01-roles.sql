-- The application connects as meridian_app, which is granted INSERT/SELECT on
-- audit_events but never UPDATE/DELETE. Migrations run as meridian_owner.
CREATE ROLE meridian_app LOGIN PASSWORD 'app_pw';
CREATE DATABASE meridian_test OWNER meridian_owner;
