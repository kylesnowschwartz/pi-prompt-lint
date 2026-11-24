import { collectInventory, type InventoryOptions } from "./inventory.ts";
import { formatReport } from "./report.ts";
import { lintInventory, type LintOptions, type LintResult } from "./rules.ts";
import { compareSnapshot } from "./snapshot.ts";

export const UPDATE_ENV = "PI_PROMPT_LINT_UPDATE";

export interface PromptLintAssertion extends LintOptions, InventoryOptions {
  /** Committed snapshot file; created when missing, rewritten when `update` or PI_PROMPT_LINT_UPDATE=1. */
  snapshot?: string;
  update?: boolean;
}

/**
 * For an extension's node:test file: lints the entries and throws when any error-severity finding
 * exists (including a budget overrun) or when the inventory differs from the snapshot.
 */
export async function assertPromptLint(entries: string[], options: PromptLintAssertion = {}): Promise<LintResult> {
  const inventory = await collectInventory(entries, options);
  const result = lintInventory(inventory, options);
  const problems: string[] = [];
  if (result.findings.some(f => f.severity === "error")) problems.push(formatReport(result));
  if (options.snapshot) {
    const { diff } = await compareSnapshot(inventory, options.snapshot, options.update ?? process.env[UPDATE_ENV] === "1");
    if (diff) problems.push(`Prompt text differs from ${options.snapshot}. Rerun with ${UPDATE_ENV}=1 to accept.\n${diff}`);
  }
  if (problems.length) throw new Error(problems.join("\n\n"));
  return result;
}
