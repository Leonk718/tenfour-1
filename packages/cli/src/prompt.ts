/**
 * tenfour CLI — minimal interactive prompts (confirm + line read). No dependencies.
 * `--yes` short-circuits to the default; consent-shaped prompts default to "no"
 * (CLI-MCP §1.1: consent is never defaulted to yes).
 */

import * as readline from 'node:readline';

export interface PromptOptions {
  yes?: boolean;
  quiet?: boolean;
}

async function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await new Promise<string>((resolve) => rl.question(question, resolve));
  } finally {
    rl.close();
  }
}

/** Yes/no confirm. `defaultYes` sets the answer on empty input; `--yes` returns `defaultYes`. */
export async function confirm(
  question: string,
  defaultYes: boolean,
  opts: PromptOptions = {},
): Promise<boolean> {
  if (opts.yes) return defaultYes;
  const suffix = defaultYes ? ' [Y/n] ' : ' [y/N] ';
  const answer = (await ask(question + suffix)).trim().toLowerCase();
  if (answer === '') return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/** Read one line of input (e.g. an invite code). `--yes` is not honored — codes are required. */
export async function readLine(question: string): Promise<string> {
  return (await ask(question)).trim();
}
