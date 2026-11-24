import type { LintResult, RuleName } from "./rules.ts";

export interface ReportStyle { bold(text: string): string }
export const plain: ReportStyle = { bold: text => text };
export const ansi: ReportStyle = { bold: text => `\x1b[1m${text}\x1b[0m` };

export function formatReport(result: LintResult, style: ReportStyle = plain): string {
  const lines: string[] = [];
  for (const total of result.totals) {
    lines.push(style.bold(`${total.source}`), `  always-on characters: ${total.alwaysOn}`);
    for (const [channel, count] of Object.entries(total.channels).sort((a, b) => b[1] - a[1])) lines.push(`    ${channel.padEnd(26)} ${String(count).padStart(7)}`);
  }
  lines.push("", `Active tools: ${result.inventory.activeTools.join(", ") || "none"}`, `Loaded skills: ${result.inventory.skills.join(", ") || "none"}`);
  if (result.inventory.uiCalls?.length) lines.push(`UI methods called, no-ops offline: ${result.inventory.uiCalls.join(", ")}`);
  lines.push("");
  const byRule = new Map<RuleName, typeof result.findings>();
  for (const finding of result.findings) byRule.set(finding.rule, [...(byRule.get(finding.rule) ?? []), finding]);
  for (const [rule, findings] of byRule) {
    lines.push(style.bold(`${rule} (${findings.length})`));
    for (const f of findings) {
      lines.push(`  ${f.severity}: ${[f.channel, f.tool].filter(Boolean).join(" ")} — ${f.message}`, `    source: ${f.source}`, `    "${f.excerpt}"`);
    }
    lines.push("");
  }
  const errors = result.findings.filter(f => f.severity === "error").length;
  lines.push(`${errors} error(s), ${result.findings.length - errors} warning(s)`);
  return lines.join("\n");
}
