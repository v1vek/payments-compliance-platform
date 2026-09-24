// Display helpers. Amounts stay integer cents; the only arithmetic here is
// integer division into dollars and a two-digit remainder.

export const fmt = (cents: number): string => {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const rem = abs % 100;
  return `${sign}$${((abs - rem) / 100).toLocaleString('en-US')}.${String(rem).padStart(2, '0')}`;
};

/** Client-side preview only (balance-after, button enablement). The server re-parses. */
export function parseCents(input: string): number | null {
  const m = /^(\d{1,9})(?:\.(\d{0,2}))?$/.exec(input.replace(/[$,\s]/g, ''));
  if (!m) return null;
  return Number(m[1]) * 100 + Number(((m[2] ?? '') + '00').slice(0, 2));
}

export const DAY = 86_400_000;

export const fmtDate = (t: string | number) =>
  new Date(t).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

export const fmtTime = (t: string | number) => {
  const d = new Date(t);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `Today, ${time}` : `${fmtDate(t)}, ${time}`;
};

export const initials = (s: string) =>
  s.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join('');

export const C = {
  green: ['#E6F4EA', '#1E7F45'], amber: ['#FFF3DC', '#9A5B00'], red: ['#FDECEA', '#B42318'],
  gray: ['#F2F2F7', '#48484A'], blue: ['#EAF2FD', '#0B63CE'],
} as const;
export type Tone = (typeof C)[keyof typeof C];

export const dotOf = (a: string) =>
  /refused|rejected|match|timed out|blocked|failed/i.test(a) ? '#B42318'
    : /hold|threshold/i.test(a) ? '#E0A030'
      : /sent|passed/i.test(a) ? '#1E7F45'
        : /Recommend|decision/i.test(a) ? '#0B63CE' : '#AEAEB2';
