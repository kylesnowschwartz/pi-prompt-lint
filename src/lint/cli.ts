#!/usr/bin/env node
import { readFileSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { agentFileProblem } from "./agent-files.ts";
import { findPi, PI_OVERRIDE_ENV, PiNotUsable, SUPPORTED_PI_VERSION, usePi } from "./pi.ts";
import { ansi, formatReport, plain } from "./report.ts";
import { lintInventory } from "./rules.ts";

export const USAGE = "Usage: pi-prompt-lint [--budget <chars>] [--allow <name>]... [--json] [--isolated-home] [--agent-file <name>]... [--pi <dir>] [<extension>...]";
const HELP = `${USAGE}

Loads each Pi extension in an offline session (no model, network, or credentials),
lists the prompt text it contributes, and checks it. An <extension> is an entry file or a
package folder (its package.json pi.extensions and pi.skills); without one, the current folder.

Pi ${SUPPORTED_PI_VERSION} is loaded from --pi, else ${PI_OVERRIDE_ENV}, else the linter's own
node_modules, else the package behind the \`pi\` executable on PATH.

Options:
  --budget <chars>  Fail when an extension's always-on characters exceed this limit
  --allow <name>    Accept <name> as a known tool or skill in reference checks (repeatable)
  --json            Print the inventory, totals, and findings as JSON
  --isolated-home   Point HOME at an empty temporary folder while extensions run
  --agent-file <name>
                    Also copy this top-level file of the pi agent folder into the throwaway agent
                    folder (repeatable); only settings.json is copied otherwise. Credential-like
                    names are refused.
  --pi <dir>        Load Pi from this pi-coding-agent package folder, or a folder whose node_modules holds it
  --version         Print the linter version
  -h, --help        Show this help

Exit status: 0 with no error findings, 1 with error findings, 2 on usage or load failure.`;

export interface CliIO {
  stdout(text: string): void;
  stderr(text: string): void;
  color: boolean;
  /** Folder linted when no extension is given; the process working directory by default. */
  cwd?: string;
  /** Environment for PATH and PI_PROMPT_LINT_PI; process.env by default. */
  env?: Record<string, string | undefined>;
}

const here = dirname(fileURLToPath(import.meta.url));

export function version(): string {
  return String(JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version);
}

export async function main(argv: string[], io: CliIO): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, options: {
      budget: { type: "string" }, allow: { type: "string", multiple: true }, json: { type: "boolean" }, help: { type: "boolean", short: "h" }, pi: { type: "string" }, version: { type: "boolean" }, "isolated-home": { type: "boolean" }, "agent-file": { type: "string", multiple: true },
    } });
  } catch (error: any) { io.stderr(`${error.message}\n${USAGE}\n`); return 2; }
  const { values, positionals } = parsed;
  if (values.help) { io.stdout(`${HELP}\n`); return 0; }
  if (values.version) { io.stdout(`pi-prompt-lint ${version()}\n`); return 0; }
  const env = io.env ?? process.env;
  const agentFiles = values["agent-file"] ?? [];
  const problem = agentFiles.map(agentFileProblem).find(Boolean);
  if (problem) { io.stderr(`${problem}\n`); return 2; }
  const entries = positionals.length ? positionals : [io.cwd ?? process.cwd()];
  let budget: number | undefined;
  if (values.budget !== undefined) {
    budget = Number(values.budget);
    if (!Number.isInteger(budget) || budget < 0) { io.stderr(`--budget must be a non-negative integer, got "${values.budget}".\n`); return 2; }
  }
  try {
    usePi(findPi({ override: values.pi ?? env[PI_OVERRIDE_ENV], from: here, path: env.PATH }));
  } catch (error: any) {
    if (error instanceof PiNotUsable) { io.stderr(`${error.message}\n`); return 2; }
    throw error;
  }
  const { collectInventory } = await import("./inventory.ts");
  let result;
  try {
    result = lintInventory(await collectInventory(entries, { isolateHome: values["isolated-home"], agentFiles }), { budget, allow: values.allow });
  } catch (error: any) { io.stderr(`Could not load extensions offline:\n${error?.message ?? error}\n`); return 2; }
  io.stdout(values.json ? `${JSON.stringify(result, null, 2)}\n` : `${formatReport(result, io.color ? ansi : plain)}\n`);
  return result.findings.some(f => f.severity === "error") ? 1 : 0;
}

const invoked = process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (invoked) {
  const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  process.exitCode = await main(process.argv.slice(2), { stdout: t => process.stdout.write(t), stderr: t => process.stderr.write(t), color });
}
