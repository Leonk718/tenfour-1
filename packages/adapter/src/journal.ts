/**
 * tenfour adapter — the local delivery journal (DELIVERY §5, §9).
 *
 * Single source of truth for "what did this machine already show the model." Inbound
 * states `received → injected → ack_pending → acked` (DEL-20) keyed by message_id;
 * outbound ops `prepared → sending → confirmed | failed | abandoned` (DEL §9). Every
 * state transition is an append + fsync. Cross-process exclusion is an O_EXCL lockfile
 * with stale detection (DEL-23) — atomic and identical on macOS, Linux, and Windows.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { ulid } from './ids.ts';

export type InboundState = 'received' | 'injected' | 'ack_pending' | 'acked';
export type OutboundState = 'prepared' | 'sending' | 'confirmed' | 'failed' | 'abandoned';

const INBOUND_RANK: Record<InboundState, number> = {
  received: 0,
  injected: 1,
  ack_pending: 2,
  acked: 3,
};

export interface InboundRecord {
  at: number;
  message_id: string;
  attempt_id: string;
  state: InboundState;
  redelivery?: boolean;
  standing_rule?: boolean;
}

export interface InboundEntry {
  message_id: string;
  attempt_id: string;
  state: InboundState;
  /** True iff a record for this message was ever written at `injected` with redelivery. */
  redelivery: boolean;
}

export interface OutboundRecord {
  at: number;
  client_id: string;
  state: OutboundState;
  content_hash?: string;
  message_id?: string;
  seq?: number;
  code?: string;
  summary?: string;
}

export interface OutboundEntry {
  client_id: string;
  state: OutboundState;
  content_hash?: string;
  message_id?: string;
  code?: string;
  summary?: string;
}

/** DEL-23 stale threshold and acquire timeout. */
const LOCK_STALE_MS = 30_000;
const LOCK_TIMEOUT_MS = 2_000;

export class Journal {
  readonly dir: string;
  readonly inboxFile: string;
  readonly outboxFile: string;
  readonly lockFile: string;
  readonly sessionFile: string;
  readonly pendingFlag: string;
  readonly demotedFlag: string;
  readonly midturnState: string;
  private lockFd: number | null = null;

  constructor(dir: string) {
    this.dir = dir;
    this.inboxFile = path.join(dir, 'inbox.jsonl');
    this.outboxFile = path.join(dir, 'outbox.jsonl');
    this.lockFile = path.join(dir, 'journal.lock');
    this.sessionFile = path.join(dir, 'session.json');
    this.pendingFlag = path.join(dir, 'pending.flag');
    this.demotedFlag = path.join(dir, 'demoted.flag');
    this.midturnState = path.join(dir, 'midturn.state');
  }

  /** Create the journal dir (0700) — idempotent. */
  ensure(): void {
    fs.mkdirSync(this.dir, { recursive: true, mode: 0o700 });
  }

  // ── Lock (DEL-23) ──────────────────────────────────────────────────────────

  /** Acquire the exclusive lock; returns true if held, false on timeout (DEL-24). */
  acquire(timeoutMs: number = LOCK_TIMEOUT_MS): boolean {
    this.ensure();
    const start = Date.now();
    for (;;) {
      try {
        const fd = fs.openSync(this.lockFile, 'wx');
        const info = JSON.stringify({ pid: process.pid, holder: `${process.pid}`, acquired_at: Date.now(), host: os.hostname() });
        fs.writeFileSync(fd, info);
        try {
          fs.fsyncSync(fd);
        } catch {
          /* fsync on some FS types is a no-op/unsupported; the O_EXCL create is the guarantee */
        }
        this.lockFd = fd;
        return true;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        if (this.breakIfStale()) continue;
        if (Date.now() - start > timeoutMs) return false;
        this.sleep(25 + Math.floor(Math.random() * 25));
      }
    }
  }

  private breakIfStale(): boolean {
    let stale = false;
    try {
      const st = fs.statSync(this.lockFile);
      if (Date.now() - st.mtimeMs > LOCK_STALE_MS) stale = true;
      else {
        try {
          const info = JSON.parse(fs.readFileSync(this.lockFile, 'utf8')) as { pid?: number };
          if (typeof info.pid === 'number') {
            try {
              process.kill(info.pid, 0);
            } catch (err) {
              if ((err as NodeJS.ErrnoException).code === 'ESRCH') stale = true;
            }
          }
        } catch {
          if (Date.now() - st.mtimeMs > LOCK_STALE_MS) stale = true;
        }
      }
    } catch {
      // lock vanished between open and stat: treat as free, retry immediately.
      return true;
    }
    if (stale) {
      try {
        fs.unlinkSync(this.lockFile);
      } catch {
        /* ENOENT or EBUSY (live Windows holder) — retry loop handles it */
      }
      return true;
    }
    return false;
  }

  release(): void {
    if (this.lockFd !== null) {
      try {
        fs.closeSync(this.lockFd);
      } catch {
        /* ignore */
      }
      this.lockFd = null;
    }
    try {
      fs.unlinkSync(this.lockFile);
    } catch {
      /* ignore */
    }
  }

  withLock<T>(fn: () => T, timeoutMs: number = LOCK_TIMEOUT_MS): T {
    if (!this.acquire(timeoutMs)) throw new Error('journal lock timeout');
    try {
      return fn();
    } finally {
      this.release();
    }
  }

  private sleep(ms: number): void {
    // Busy-wait: hooks are short-lived and must not depend on async in the lock loop.
    const until = Date.now() + ms;
    while (Date.now() < until) {
      /* spin */
    }
  }

  // ── Append primitives (append + fsync, DEL-21) ──────────────────────────────

  private appendLine(file: string, obj: unknown): void {
    const fd = fs.openSync(file, 'a', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(obj) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  private readLines<T>(file: string): T[] {
    if (!fs.existsSync(file)) return [];
    const text = fs.readFileSync(file, 'utf8');
    const out: T[] = [];
    for (const line of text.split('\n')) {
      const t = line.trim();
      if (t.length === 0) continue;
      try {
        out.push(JSON.parse(t) as T);
      } catch {
        /* skip a torn trailing line (crash matrix C9) */
      }
    }
    return out;
  }

  // ── Inbound ────────────────────────────────────────────────────────────────

  appendInbound(rec: InboundRecord): void {
    this.appendLine(this.inboxFile, rec);
  }

  readInbound(): InboundRecord[] {
    return this.readLines<InboundRecord>(this.inboxFile);
  }

  /** Reduce the append-only log to the current state per message_id. */
  states(): Map<string, InboundEntry> {
    const map = new Map<string, InboundEntry>();
    for (const r of this.readInbound()) {
      const prev = map.get(r.message_id);
      const redelivery = (prev?.redelivery ?? false) || r.redelivery === true;
      if (!prev || INBOUND_RANK[r.state] >= INBOUND_RANK[prev.state]) {
        map.set(r.message_id, { message_id: r.message_id, attempt_id: r.attempt_id, state: r.state, redelivery });
      } else {
        map.set(r.message_id, { ...prev, redelivery });
      }
    }
    return map;
  }

  stateOf(messageId: string): InboundState | null {
    return this.states().get(messageId)?.state ?? null;
  }

  hasSeen(messageId: string): boolean {
    return this.states().has(messageId);
  }

  recordReceived(messageId: string, attemptId: string, opts: { standing_rule?: boolean } = {}): void {
    this.appendInbound({ at: Date.now(), message_id: messageId, attempt_id: attemptId, state: 'received', ...opts });
  }

  /** Append `injected`; if the message was already at `injected` (crash leftover), mark redelivery (DEL-27). */
  recordInjected(messageId: string, attemptId: string): boolean {
    const cur = this.stateOf(messageId);
    const redelivery = cur === 'injected';
    this.appendInbound({ at: Date.now(), message_id: messageId, attempt_id: attemptId, state: 'injected', ...(redelivery ? { redelivery: true } : {}) });
    return redelivery;
  }

  recordAckPending(messageId: string, attemptId: string): void {
    this.appendInbound({ at: Date.now(), message_id: messageId, attempt_id: attemptId, state: 'ack_pending' });
  }

  recordAcked(messageId: string, attemptId: string): void {
    this.appendInbound({ at: Date.now(), message_id: messageId, attempt_id: attemptId, state: 'acked' });
  }

  /** Messages injected but not yet ack_pending/acked — re-present WITH the redelivery preamble (DEL-27). */
  pendingRedelivery(): InboundEntry[] {
    return [...this.states().values()].filter((e) => e.state === 'injected');
  }

  // ── Outbound (R11 / DELIVERY §9) ─────────────────────────────────────────────

  appendOutbound(rec: OutboundRecord): void {
    this.appendLine(this.outboxFile, rec);
  }

  readOutbound(): OutboundRecord[] {
    return this.readLines<OutboundRecord>(this.outboxFile);
  }

  outboundStates(): Map<string, OutboundEntry> {
    const map = new Map<string, OutboundEntry>();
    for (const r of this.readOutbound()) {
      map.set(r.client_id, {
        client_id: r.client_id,
        state: r.state,
        content_hash: r.content_hash ?? map.get(r.client_id)?.content_hash,
        message_id: r.message_id ?? map.get(r.client_id)?.message_id,
        code: r.code,
        summary: r.summary ?? map.get(r.client_id)?.summary,
      });
    }
    return map;
  }

  recordPrepared(clientId: string, contentHash: string, summary?: string): void {
    this.appendOutbound({ at: Date.now(), client_id: clientId, state: 'prepared', content_hash: contentHash, summary });
  }

  recordSending(clientId: string): void {
    this.appendOutbound({ at: Date.now(), client_id: clientId, state: 'sending' });
  }

  recordConfirmed(clientId: string, messageId: string, seq: number): void {
    this.appendOutbound({ at: Date.now(), client_id: clientId, state: 'confirmed', message_id: messageId, seq });
  }

  recordFailed(clientId: string, code: string): void {
    this.appendOutbound({ at: Date.now(), client_id: clientId, state: 'failed', code });
  }

  recordAbandoned(clientId: string): void {
    this.appendOutbound({ at: Date.now(), client_id: clientId, state: 'abandoned' });
  }

  // ── Session identity (DEL-12) ───────────────────────────────────────────────

  holderId(): string {
    this.ensure();
    if (fs.existsSync(this.sessionFile)) {
      try {
        const s = JSON.parse(fs.readFileSync(this.sessionFile, 'utf8')) as { holder?: string };
        if (typeof s.holder === 'string' && s.holder.length > 0) return s.holder;
      } catch {
        /* fall through and re-mint */
      }
    }
    const holder = ulid();
    fs.writeFileSync(this.sessionFile, JSON.stringify({ holder, created_at: Date.now() }));
    return holder;
  }

  // ── Flags (DELIVERY §11) ─────────────────────────────────────────────────────

  writePendingFlag(payload: { count: number; latest_message_id: string }): void {
    const tmp = `${this.pendingFlag}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ ...payload, written_at: Date.now() }));
    fs.renameSync(tmp, this.pendingFlag);
  }

  statMtime(file: string): number | null {
    try {
      return fs.statSync(file).mtimeMs;
    } catch {
      return null;
    }
  }

  midturnWatermark(): number {
    try {
      return Number(fs.readFileSync(this.midturnState, 'utf8')) || 0;
    } catch {
      return 0;
    }
  }

  setMidturnWatermark(ms: number = Date.now()): void {
    fs.writeFileSync(this.midturnState, String(ms));
  }

  isDemoted(): boolean {
    return fs.existsSync(this.demotedFlag);
  }

  setDemoted(): void {
    try {
      fs.writeFileSync(this.demotedFlag, JSON.stringify({ at: Date.now() }));
    } catch {
      /* best-effort */
    }
  }
}
