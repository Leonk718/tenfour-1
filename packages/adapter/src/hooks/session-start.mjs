#!/usr/bin/env node
/** tenfour SessionStart hook — inject queued inbox (I1). Delegates to the shared entry. */
import { runHook } from './tenfour-hook.mjs';
runHook('session-start');
