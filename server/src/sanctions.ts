import type { Queryable } from './db.js';

export type ScreeningMatch = { entry: string; type: string; score: number };

export type ScreeningOutcome =
  | { kind: 'clear' }
  | { kind: 'match'; match: ScreeningMatch }
  | { kind: 'unavailable'; reason: 'timeout' | 'error'; message: string };

/** Why a screening call is being made: the first check, or a re-check before releasing a held payment. */
export type ScreeningPurpose = 'initial' | 'rescreen';

/** Port for an external sanctions-screening provider. */
export interface SanctionsScreener {
  screen(name: string, signal: AbortSignal, purpose: ScreeningPurpose): Promise<{ match: ScreeningMatch | null }>;
}

const MATCH_THRESHOLD = 0.85;

/** Lower-case, strip company suffixes/punctuation, and fold common spelling swaps. */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\b(llc|ltd|inc|co|holdings|limited|corp|gmbh|sa)\b/g, '')
    .replace(/[^a-z ]/g, '')
    .replace(/ph/g, 'f')
    .replace(/ck/g, 'k')
    .replace(/c/g, 'k')
    .replace(/w/g, 'v')
    .replace(/v/g, 'f')
    .replace(/y/g, 'i')
    .replace(/(.)\1+/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length]!;
}

const sortTokens = (s: string) => s.split(' ').sort().join(' ');

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a.includes(b)) return 1;
  return 1 - levenshtein(a, b) / Math.max(a.length, b.length);
}

/** Pure matcher: exact, contained, or fuzzy (≥85%) match, word order insensitive. */
export function matchName(name: string, entries: readonly string[]): ScreeningMatch | null {
  const raw = name.trim().toLowerCase().replace(/\s+/g, ' ');
  const n = normalizeName(name);
  let best: ScreeningMatch | null = null;
  for (const entry of entries) {
    if (raw === entry.toLowerCase()) return { entry, type: 'Exact match', score: 1 };
    const e = normalizeName(entry);
    const score = Math.max(similarity(n, e), similarity(sortTokens(n), sortTokens(e)));
    if (!best || score > best.score) best = { entry, type: '', score };
  }
  if (!best || best.score < MATCH_THRESHOLD) return null;
  return { ...best, type: `Spelling variant · ${Math.round(best.score * 100)}% similarity` };
}

/**
 * Stub adapter standing in for a vendor API. Reads the list from Postgres and
 * adds a little latency. To demonstrate the fail-closed path, the initial
 * screening of any recipient containing "timeout test" never answers
 * (a simulated outage); the re-screen on release answers normally.
 */
export class StubSanctionsScreener implements SanctionsScreener {
  constructor(
    private readonly db: Queryable,
    private readonly latencyMs = 600,
  ) {}

  async screen(name: string, signal: AbortSignal, purpose: ScreeningPurpose): Promise<{ match: ScreeningMatch | null }> {
    const hang = purpose === 'initial' && /timeout test/i.test(name);
    await new Promise<void>((resolve, reject) => {
      const t = hang ? undefined : setTimeout(resolve, this.latencyMs);
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new Error('aborted'));
      }, { once: true });
    });
    const { rows } = await this.db.query<{ name: string }>('SELECT name FROM sanctions_entries');
    return { match: matchName(name, rows.map((r) => r.name)) };
  }
}

/** Calls the screener with a hard deadline. Never throws; failure is an outcome. */
export async function screenWithTimeout(
  screener: SanctionsScreener,
  name: string,
  timeoutMs: number,
  purpose: ScreeningPurpose,
): Promise<ScreeningOutcome> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<ScreeningOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ kind: 'unavailable', reason: 'timeout', message: `No response within ${timeoutMs}ms` });
    }, timeoutMs);
  });
  const call = screener.screen(name, controller.signal, purpose).then(
    (r): ScreeningOutcome => (r.match ? { kind: 'match', match: r.match } : { kind: 'clear' }),
    (err: unknown): ScreeningOutcome => ({
      kind: 'unavailable',
      reason: controller.signal.aborted ? 'timeout' : 'error',
      message: err instanceof Error ? err.message : String(err),
    }),
  );
  try {
    return await Promise.race([call, deadline]);
  } finally {
    clearTimeout(timer);
  }
}
