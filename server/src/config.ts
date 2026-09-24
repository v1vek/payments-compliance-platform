function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a whole number, got "${raw}"`);
  return Number(raw);
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://meridian_app:app_pw@localhost:5433/meridian',
  port: int('PORT', 4000),
  sanctionsTimeoutMs: int('SANCTIONS_TIMEOUT_MS', 5000),
  reviewThresholdCents: int('REVIEW_THRESHOLD_CENTS', 800_000),
  windowDays: 7,
  sessionHours: 8,
  demoMode: process.env.DEMO_MODE === 'true',
  secureCookies: process.env.NODE_ENV === 'production',
};
