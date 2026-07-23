// @vitest-environment node
/**
 * Journal state transitions (received→injected→ack_pending→acked), crash-point recovery
 * (a message injected-but-unacked re-presents with redelivery), outbound op states, and
 * the O_EXCL lockfile exclusivity (DELIVERY §5).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Journal } from './journal.ts';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-journal-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const MID = '01J1PAVH5N40E3D8QT2W9YRKM3';
const ATT = '01J1PAVH5N40E3D8QT2W9YRKM4';

describe('inbound state transitions', () => {
  it('walks received → injected → ack_pending → acked', () => {
    const j = new Journal(dir);
    j.ensure();
    j.recordReceived(MID, ATT);
    expect(j.stateOf(MID)).toBe('received');
    j.recordInjected(MID, ATT);
    expect(j.stateOf(MID)).toBe('injected');
    j.recordAckPending(MID, ATT);
    expect(j.stateOf(MID)).toBe('ack_pending');
    j.recordAcked(MID, ATT);
    expect(j.stateOf(MID)).toBe('acked');
  });

  it('hasSeen dedups cross-process', () => {
    const j = new Journal(dir);
    j.ensure();
    expect(j.hasSeen(MID)).toBe(false);
    j.recordReceived(MID, ATT);
    expect(new Journal(dir).hasSeen(MID)).toBe(true); // reduced from the file, not memory
  });
});

describe('crash recovery (DEL-27)', () => {
  it('an injected-but-unacked message re-presents with redelivery', () => {
    const j = new Journal(dir);
    j.ensure();
    j.recordReceived(MID, ATT);
    j.recordInjected(MID, ATT); // C4/C5: crashed before ack
    // Recovery: pendingRedelivery surfaces it; a fresh inject marks redelivery.
    expect(j.pendingRedelivery().map((e) => e.message_id)).toContain(MID);
    const wasRedelivery = j.recordInjected(MID, ATT);
    expect(wasRedelivery).toBe(true);
    expect(j.states().get(MID)?.redelivery).toBe(true);
  });

  it('an acked message is not pending redelivery', () => {
    const j = new Journal(dir);
    j.ensure();
    j.recordReceived(MID, ATT);
    j.recordInjected(MID, ATT);
    j.recordAckPending(MID, ATT);
    j.recordAcked(MID, ATT);
    expect(j.pendingRedelivery()).toHaveLength(0);
  });
});

describe('outbound ops (R11)', () => {
  it('walks prepared → sending → confirmed', () => {
    const j = new Journal(dir);
    j.ensure();
    j.recordPrepared('cid1', 'sha256:abc');
    j.recordSending('cid1');
    j.recordConfirmed('cid1', MID, 4);
    expect(j.outboundStates().get('cid1')?.state).toBe('confirmed');
    expect(j.outboundStates().get('cid1')?.message_id).toBe(MID);
  });
  it('records a failed op terminal', () => {
    const j = new Journal(dir);
    j.ensure();
    j.recordPrepared('cid2', 'sha256:def');
    j.recordSending('cid2');
    j.recordFailed('cid2', 'TENFOUR/STALE_HEAD');
    expect(j.outboundStates().get('cid2')?.state).toBe('failed');
  });
});

describe('lockfile (DEL-23)', () => {
  it('is exclusive: a second acquire fails while held', () => {
    const a = new Journal(dir);
    const b = new Journal(dir);
    expect(a.acquire()).toBe(true);
    expect(b.acquire(200)).toBe(false); // held by a
    a.release();
    expect(b.acquire(200)).toBe(true);
    b.release();
  });
  it('withLock releases even on throw', () => {
    const j = new Journal(dir);
    expect(() =>
      j.withLock(() => {
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(j.acquire(200)).toBe(true); // lock was released
    j.release();
  });
});

describe('session holder (DEL-12)', () => {
  it('mints once and is stable across instances', () => {
    const h1 = new Journal(dir).holderId();
    const h2 = new Journal(dir).holderId();
    expect(h1).toBe(h2);
  });
});
