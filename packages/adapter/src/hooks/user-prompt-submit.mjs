#!/usr/bin/env node
/** tenfour UserPromptSubmit hook — prepend pending messages (I2). Delegates to the shared entry. */
import { runHook } from './tenfour-hook.mjs';
runHook('user-prompt-submit');
