import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Db } from './db.js';
import { audit, SYSTEM } from './audit.js';
import { AppError } from './errors.js';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = 'customer' | 'compliance';
export type SessionUser = { id: string; email: string; name: string; role: Role; label: string; initials: string };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 32);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, saltB64, keyB64] = stored.split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length);
  return timingSafeEqual(actual, expected);
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

// Used when the email is unknown so the response time doesn't reveal which emails exist.
const DUMMY_HASH = 'scrypt$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

export async function login(db: Db, email: string, password: string, sessionHours: number) {
  const { rows } = await db.query<SessionUser & { password_hash: string }>(
    'SELECT id, email, name, role, label, initials, password_hash FROM users WHERE email = $1',
    [email.trim().toLowerCase()],
  );
  const row = rows[0];
  const ok = await verifyPassword(password, row?.password_hash ?? DUMMY_HASH);
  if (!row || !ok) {
    // Record the attempt, but never the password, and never echo an unknown email into the log.
    await audit(db, row ?? SYSTEM, 'Sign-in failed', row ? `Wrong password for ${row.email}` : 'Unknown email');
    throw new AppError(401, 'invalid_credentials', 'Email or password is incorrect.');
  }

  const token = randomBytes(32).toString('base64url');
  await db.query(
    `INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, now() + make_interval(hours => $3))`,
    [sha256(token), row.id, sessionHours],
  );
  const { password_hash: _, ...user } = row;
  await audit(db, user, 'Signed in', `${user.label} · ${user.email}`);
  return { token, user };
}

export async function userForToken(db: Db, token: string | undefined): Promise<SessionUser | null> {
  if (!token) return null;
  const { rows } = await db.query<SessionUser>(
    `SELECT u.id, u.email, u.name, u.role, u.label, u.initials
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.expires_at > now()`,
    [sha256(token)],
  );
  return rows[0] ?? null;
}

export async function logout(db: Db, token: string, user: SessionUser): Promise<void> {
  await db.query('DELETE FROM sessions WHERE token_hash = $1', [sha256(token)]);
  await audit(db, user, 'Signed out', `${user.label} · ${user.email}`);
}
