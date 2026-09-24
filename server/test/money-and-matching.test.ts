import { describe, expect, it } from 'vitest';
import { formatUsd, parseCents } from '../src/money.js';
import { matchName } from '../src/sanctions.js';
import { SANCTIONS_LIST } from '../src/demo.js';

describe('money parsing', () => {
  it('parses amounts to integer cents without floats', () => {
    expect(parseCents('2000')).toBe(200_000);
    expect(parseCents('7,500.00')).toBe(750_000);
    expect(parseCents('$0.10')).toBe(10);
    expect(parseCents('19.9')).toBe(1990);
    expect(parseCents('0.29')).toBe(29); // 0.29 * 100 = 28.999999999999996 in floating point
  });

  it('refuses sub-cent precision, negatives, exponents and junk', () => {
    for (const bad of ['12.345', '-5', '1e5', 'abc', '', '.', '12..3', 'NaN', 'Infinity']) {
      expect(parseCents(bad), bad).toBeNull();
    }
  });

  it('formats cents with integer arithmetic', () => {
    expect(formatUsd(950_000)).toBe('$9,500.00');
    expect(formatUsd(5)).toBe('$0.05');
  });
});

describe('sanctions name matching', () => {
  it('matches exact names and spelling variants', () => {
    expect(matchName('Viktor Orlanov', SANCTIONS_LIST)?.type).toBe('Exact match');
    for (const variant of ['Victor Orlanoff', 'VIKTOR ORLANOV', 'Nadia Petrakowa', 'Karim Zahidi',
      'Oceanic Delta Trading LLC', 'Soren Malverdi', 'Orlanov Viktor', 'Sören Malverde']) {
      expect(matchName(variant, SANCTIONS_LIST), variant).not.toBeNull();
    }
  });

  it('matches common typos: missing, extra, wrong or swapped letters', () => {
    for (const typo of ['Viktr Orlanov', 'Viktor Orlanovv', 'Viktor Orlamov', 'Vikotr Orlanov', 'ViktorOrlanov',
      'Nadia Petrkova', 'Nadai Petrakova', 'Karim Zahdi', 'Karim Zaehdi', 'Kareem Zahedi',
      'Oceanic Delta Tradng', 'Ocaenic Delta Trading', 'Soren Malvedre', 'Søren Malverde']) {
      expect(matchName(typo, SANCTIONS_LIST), typo).not.toBeNull();
    }
  });

  it('does not match initials, a surname alone or a partial company name (too broad to refuse on)', () => {
    for (const partial of ['V. Orlanov', 'Orlanov', 'Oceanic Delta', 'Vktr Orlnv']) {
      expect(matchName(partial, SANCTIONS_LIST), partial).toBeNull();
    }
  });

  it('errs on the side of caution for near-identical names', () => {
    // Two letters away from "Nadia Petrakova". Screening tools flag names this close;
    // letting a sanctioned name through is the failure that can't be undone.
    expect(matchName('Nadia Petrova', SANCTIONS_LIST)?.entry).toBe('Nadia Petrakova');
  });

  it('does not flag ordinary suppliers', () => {
    for (const ok of ['Lindqvist Components GmbH', 'Saigon Textile Works', 'Harbor Freight Co.',
      'Victoria Orlando', 'Nadia Peters', 'Delta Airlines', 'Karen Zahid', 'Delta Trading Co', 'Victor Oliveira',
      'Karim Zaidi Imports', 'Soren Madsen']) {
      expect(matchName(ok, SANCTIONS_LIST), ok).toBeNull();
    }
  });
});

describe('stub screener outage simulation', () => {
  it('"timeout test" recipients always time out on initial screening and pass on re-screen', async () => {
    const { StubSanctionsScreener, screenWithTimeout } = await import('../src/sanctions.js');
    const fakeDb = { query: async () => ({ rows: SANCTIONS_LIST.map((name) => ({ name })) }) };
    const s = new StubSanctionsScreener(fakeDb as never, 1);
    for (let i = 0; i < 3; i++) {
      expect((await screenWithTimeout(s, 'Timeout Test Supplier', 50, 'initial')).kind).toBe('unavailable');
    }
    expect((await screenWithTimeout(s, 'Timeout Test Supplier', 50, 'rescreen')).kind).toBe('clear');
    expect((await screenWithTimeout(s, 'Victor Orlanoff', 50, 'initial')).kind).toBe('match');
    expect((await screenWithTimeout(s, 'Lindqvist Components GmbH', 50, 'initial')).kind).toBe('clear');
  });
});
