/**
 * executor.ts — JXA script executor
 *
 * Executes JXA scripts via macOS osascript -l JavaScript
 * to communicate with DEVONthink.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

const DEFAULT_TIMEOUT = Number(process.env.JXA_TIMEOUT) || 30_000;

/**
 * Execute a JXA script and return stdout (typically a JSON string).
 * All scripts should end with JSON.stringify(...) to return structured data.
 */
export async function runJXA(
  script: string,
  timeout: number = DEFAULT_TIMEOUT,
): Promise<string> {
  try {
    const { stdout } = await exec("osascript", ["-l", "JavaScript", "-e", script], {
      timeout,
      maxBuffer: 100 * 1024 * 1024, // 100 MB — large databases (6GB+) produce big JSON
      env: { ...process.env, LANG: "en_US.UTF-8" },
    });
    return stdout.trim();
  } catch (err: unknown) {
    const e = err as Error & { stderr?: string; killed?: boolean };
    if (e.killed) {
      throw new Error(
        `JXA script timed out (${timeout}ms). DEVONthink may be unresponsive.`,
      );
    }
    const detail = e.stderr?.trim() || e.message;
    throw new Error(`JXA execution failed: ${detail}`);
  }
}

/**
 * Execute a JXA script and parse stdout as JSON.
 */
export async function runJXAJSON<T = unknown>(
  script: string,
  timeout?: number,
): Promise<T> {
  const raw = await runJXA(script, timeout);
  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`JXA returned unparseable JSON: ${raw.slice(0, 200)}`);
  }
}

/**
 * Escape a string for safe embedding in JXA code (within JSON.stringify calls).
 * Primarily prevents backtick template injection.
 */
export function escapeForJXA(s: string): string {
  return JSON.stringify(s);
}
