/**
 * terminal.ts — Terminal interaction: readline + chalk + ora
 */

import * as readline from "node:readline";
import chalk from "chalk";
import ora, { type Ora } from "ora";

// ─── Output Utilities ────────────────────────────────────

export const log = {
  info: (msg: string) => console.log(chalk.cyan("ℹ ") + msg),
  success: (msg: string) => console.log(chalk.green("✓ ") + msg),
  warn: (msg: string) => console.log(chalk.yellow("⚠ ") + msg),
  error: (msg: string) => console.error(chalk.red("✗ ") + msg),
  tool: (name: string, detail?: string) =>
    console.log(
      chalk.magenta("  ⚙ ") +
        chalk.magenta.bold(name) +
        (detail ? chalk.gray(" " + detail) : ""),
    ),
  toolDone: (name: string, ms: number) =>
    console.log(chalk.green("  ✓ ") + chalk.green(name) + chalk.gray(` (${ms}ms)`)),
  divider: () => console.log(chalk.gray("─".repeat(60))),
  blank: () => console.log(),
};

// ─── Spinner ─────────────────────────────────────────────

let spinner: Ora | null = null;

export function startSpinner(text: string): void {
  spinner = ora({ text, color: "cyan" }).start();
}

export function updateSpinner(text: string): void {
  if (spinner) spinner.text = text;
}

export function stopSpinner(): void {
  if (spinner) {
    spinner.stop();
    spinner = null;
  }
}

// ─── readline Input ──────────────────────────────────────

export function createPrompt(): readline.Interface {
  return readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
}

export function askQuestion(rl: readline.Interface, prompt: string): Promise<string> {
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => resolve(answer));
  });
}

// ─── Welcome Banner ──────────────────────────────────────

export function printBanner(version?: string): void {
  const ver = version || "0.0.0";
  const verPad = `v${ver}`.padStart(6);
  log.blank();
  console.log(chalk.cyan.bold("  ╔═══════════════════════════════════════════════╗"));
  console.log(chalk.cyan.bold(`  ║       DEVONthink Agent AI  ${verPad}            ║`));
  console.log(chalk.cyan.bold("  ║    Claude / GPT / Gemini + JXA + Web         ║"));
  console.log(chalk.cyan.bold("  ╚═══════════════════════════════════════════════╝"));
  log.blank();
}

export function printStatus(opts: { provider: string; model: string }): void {
  log.info(`Provider: ${chalk.bold(opts.provider)} / Model: ${chalk.bold(opts.model)}`);
  log.info(
    `Database access: ${chalk.green.bold("read-only")} | Web: ${chalk.green.bold("enabled")}`,
  );
  log.info(
    `Type ${chalk.bold("/help")} for commands, ${chalk.bold("/model")} to switch model`,
  );
  log.divider();
}

export function printHelp(): void {
  console.log(chalk.bold("\n  Basic Commands:"));
  console.log("    /help                        Show this help");
  console.log("    /model <provider> [model]     Switch LLM (anthropic/openai/gemini)");
  console.log("    /tools                       Show available tools");
  console.log("    /usage                       Show session token usage & cost");
  console.log("    /compact                     Trim history to save context window");
  console.log("    /clear                       Clear conversation history");
  console.log("    /version                     Show version & check for updates");
  console.log("    /exit                        Exit");
  console.log(chalk.bold("\n  Semantic Index:"));
  console.log("    /index [database]            Build/update semantic search index");
  console.log("    /index --force               Force full rebuild");
  console.log("    /index --status              Show index status");
  console.log(chalk.bold("\n  Research Tools:"));
  console.log(
    "    /expand <topic>              Deep research expansion — analyze existing materials & discover new directions",
  );
  console.log("    /export [filename]           Export last response as Markdown file");
  console.log(chalk.bold("\n  Model Switch Examples:"));
  console.log("    /model anthropic              Claude Sonnet (default)");
  console.log("    /model openai gpt-4o          GPT-4o");
  console.log("    /model gemini                 Gemini Flash");
  console.log(chalk.bold("\n  Usage Examples:"));
  console.log('    Search all documents about "machine learning" in the database');
  console.log("    /index                       Build semantic index first");
  console.log("    /expand schistosomiasis ultrasound diagnosis");
  console.log("    /export research-report\n");
}
