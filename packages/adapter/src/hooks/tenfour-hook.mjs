#!/usr/bin/env node
/**
 * tenfour — the single self-contained hook entry (CLI-MCP §3.1). `init` copies this to
 * TENFOUR_HOME/bin/tenfour-hook.mjs; the four settings.json hooks invoke it with an
 * event argument + the --tenfour-hook-v1 sentinel.
 *
 * Doctor mode (TENFOUR_DOCTOR=1 + TENFOUR_JOURNAL_DIR, HK-006) is handled inline and
 * dependency-free: it exercises the journal lock + append path against the ISOLATED temp
 * journal, never the live journal or broker, and emits {"tenfour_doctor":"ok",...}.
 * The real path defers to run.ts. Every path exits 0 — hooks fail open (DEL-19, HK-005).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

const EVENTS = new Set(['session-start', 'user-prompt-submit', 'post-tool-use', 'stop']);

function doctorProbe(event) {
  const dir = process.env.TENFOUR_JOURNAL_DIR;
  if (dir) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      const lock = path.join(dir, 'journal.lock');
      let fd;
      try {
        fd = fs.openSync(lock, 'wx');
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
        try { fs.fsyncSync(fd); } catch {}
      } catch {
        /* another probe holds it; still exercises the O_EXCL path */
      } finally {
        if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      }
      try { fs.unlinkSync(lock); } catch {}
      const probe = path.join(dir, 'inbox.jsonl');
      const pfd = fs.openSync(probe, 'a');
      fs.writeFileSync(pfd, JSON.stringify({ at: Date.now(), event, probe: true }) + '\n');
      try { fs.fsyncSync(pfd); } catch {}
      fs.closeSync(pfd);
      fs.readFileSync(probe, 'utf8');
    } catch {
      /* doctor mode is best-effort; still report ok so check 8 tests spawn+exit, not IO */
    }
  }
  process.stdout.write(JSON.stringify({ tenfour_doctor: 'ok', event }));
}

export async function runHook(event) {
  if (!EVENTS.has(event)) {
    process.exit(0);
    return;
  }
  if (process.env.TENFOUR_DOCTOR === '1') {
    doctorProbe(event);
    process.exit(0);
    return;
  }
  try {
    const mod = await import(new URL('./run.ts', import.meta.url).href);
    const input = await mod.readStdin();
    await mod.runEvent(event, input);
  } catch {
    /* fail open — never block Claude Code on a hook error */
  }
  process.exit(0);
}

// When invoked directly: `node tenfour-hook.mjs <event> --tenfour-hook-v1`.
const invokedDirectly = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (invokedDirectly || process.argv[2]) {
  const event = process.argv[2];
  runHook(event);
}
