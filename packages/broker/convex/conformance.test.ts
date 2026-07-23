// @vitest-environment node
/**
 * Conformance-fixtures gate (DESIGN R13; launch condition 4a).
 *
 * Loops packages/schema/src/protocol.ts CONFORMANCE_FIXTURES and asserts that each
 * fixture's ClientEnvelopeSchema.safeParse outcome equals its declared `expect`
 * (accept ⇔ safeParse succeeds). Pure + synchronous — no convex, no network.
 *
 * Also asserts the corpus size (32) and that every ART id carries at least one
 * accept AND one reject case, so the artifact-rule surface is exercised in both
 * directions (ARTIFACTS §9 sending-adapter conformance requirement).
 */
import { describe, test, expect } from 'vitest';
import { CONFORMANCE_FIXTURES, ClientEnvelopeSchema } from '../../schema/src/protocol.ts';

const modules = import.meta.glob('./**/*.*s'); // parity with the broker harness; unused here
void modules;

describe('conformance fixtures — ClientEnvelopeSchema (protocol.ts CONFORMANCE_FIXTURES)', () => {
  test('the corpus holds exactly 32 fixtures', () => {
    expect(CONFORMANCE_FIXTURES.length).toBe(32);
  });

  // One named assertion per fixture: safeParse outcome must equal the declared expect.
  CONFORMANCE_FIXTURES.forEach((fx, i) => {
    test(`#${i} ${fx.art} [${fx.expect}] ${fx.rule}`, () => {
      const res = ClientEnvelopeSchema.safeParse(fx.envelope);
      expect(
        res.success,
        `${fx.art} "${fx.rule}" expected ${fx.expect} but safeParse ${res.success ? 'accepted' : 'rejected'}`,
      ).toBe(fx.expect === 'accept');
    });
  });

  test('every fixture outcome matches its expect (aggregate)', () => {
    const mismatches = CONFORMANCE_FIXTURES.filter(
      (fx) => ClientEnvelopeSchema.safeParse(fx.envelope).success !== (fx.expect === 'accept'),
    );
    expect(mismatches.map((m) => `${m.art}:${m.rule}:${m.expect}`)).toEqual([]);
  });

  test('every ART id carries at least one accept AND one reject case', () => {
    const byArt = new Map<string, { accept: number; reject: number }>();
    for (const fx of CONFORMANCE_FIXTURES) {
      const e = byArt.get(fx.art) ?? { accept: 0, reject: 0 };
      e[fx.expect] += 1;
      byArt.set(fx.art, e);
    }
    // Sanity: the fixtures span multiple distinct artifact rules.
    expect(byArt.size).toBeGreaterThanOrEqual(10);
    const oneSided = [...byArt.entries()].filter(([, c]) => c.accept === 0 || c.reject === 0);
    expect(
      oneSided.map(([art, c]) => `${art} (accept=${c.accept}, reject=${c.reject})`),
    ).toEqual([]);
  });

  test('both accept and reject cases exist across the corpus', () => {
    expect(CONFORMANCE_FIXTURES.some((f) => f.expect === 'accept')).toBe(true);
    expect(CONFORMANCE_FIXTURES.some((f) => f.expect === 'reject')).toBe(true);
  });
});
