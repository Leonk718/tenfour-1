#!/usr/bin/env node
/** tenfour PostToolUse hook — mid-turn delivery via journal pending.flag stat (I4, local-only). */
import { runHook } from './tenfour-hook.mjs';
runHook('post-tool-use');
