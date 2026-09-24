// Money is integer cents end to end. Amounts arrive as strings and are parsed
// digit by digit; no floating-point value ever represents money.

export const MAX_PAYMENT_CENTS = 100_000_000; // $1,000,000.00

export function parseCents(input: string): number | null {
  const s = input.replace(/[$,\s]/g, '');
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(s);
  if (!m) return null;
  const whole = Number(m[1]);
  const frac = Number(((m[2] ?? '') + '00').slice(0, 2));
  return whole * 100 + frac;
}

export function formatUsd(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error('cents must be a safe integer');
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const rem = abs % 100;
  const dollars = (abs - rem) / 100;
  return `${sign}$${dollars.toLocaleString('en-US')}.${String(rem).padStart(2, '0')}`;
}
