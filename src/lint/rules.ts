import type { Channel, Inventory, InventoryRecord } from "./inventory.ts";

export type RuleName = "budget" | "duplicate-sentence" | "unknown-reference" | "guideline-names-tool";
export interface Finding {
  rule: RuleName;
  severity: "error" | "warning";
  source: string;
  channel: Channel | "always-on";
  tool?: string;
  message: string;
  excerpt: string;
}
export interface LintOptions {
  /** Maximum always-on characters per extension. Without it, the budget rule reports nothing. */
  budget?: number;
  /** Names `unknown-reference` accepts in addition to active tools and loaded skills. */
  allow?: string[];
}
export interface SourceTotals {
  source: string;
  alwaysOn: number;
  channels: Partial<Record<Channel, number>>;
}
export interface LintResult {
  inventory: Inventory;
  totals: SourceTotals[];
  findings: Finding[];
}

const MIN_WORDS = 6;
const excerpt = (text: string, max = 120) => {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
};
const where = (r: InventoryRecord) => [r.channel, r.tool ?? r.name].filter(Boolean).join(" ");

export function totals(inventory: Inventory): SourceTotals[] {
  const bySource = new Map<string, SourceTotals>();
  for (const source of inventory.extensions) bySource.set(source, { source, alwaysOn: 0, channels: {} });
  for (const r of inventory.records) {
    if (!r.alwaysOn) continue;
    const entry = bySource.get(r.source) ?? { source: r.source, alwaysOn: 0, channels: {} };
    entry.alwaysOn += r.characters;
    entry.channels[r.channel] = (entry.channels[r.channel] ?? 0) + r.characters;
    bySource.set(r.source, entry);
  }
  return [...bySource.values()];
}

export function budgetRule(inventory: Inventory, budget?: number): Finding[] {
  if (budget === undefined) return [];
  return totals(inventory).filter(t => t.alwaysOn > budget).map(t => ({
    rule: "budget", severity: "error", source: t.source, channel: "always-on",
    message: `Always-on prompt text is ${t.alwaysOn} characters, over the budget of ${budget}.`,
    excerpt: Object.entries(t.channels).map(([channel, count]) => `${channel} ${count}`).join(", "),
  }));
}

/** Splits on sentence-ending punctuation, line breaks and list bullets. */
export function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map(s => s.replace(/^\s*(?:[-*]|\d+\.)\s+/, "").trim()).filter(Boolean);
}
const normalise = (sentence: string) => sentence.toLowerCase().replace(/\s+/g, " ").replace(/[.!?;:]+$/, "").trim();

export function duplicateSentenceRule(inventory: Inventory): Finding[] {
  const seen = new Map<string, { sentence: string; records: InventoryRecord[] }>();
  for (const r of inventory.records) {
    const inRecord = new Set<string>();
    for (const sentence of sentences(r.text)) {
      const key = normalise(sentence);
      if (key.split(" ").length < MIN_WORDS || inRecord.has(key)) continue;
      inRecord.add(key);
      const entry = seen.get(key) ?? { sentence, records: [] };
      entry.records.push(r);
      seen.set(key, entry);
    }
  }
  return [...seen.values()].filter(e => e.records.length > 1).map(({ sentence, records }) => ({
    rule: "duplicate-sentence", severity: "warning", source: records[0].source, channel: records[0].channel, tool: records[0].tool,
    message: `Sentence appears in ${records.length} entries: ${records.map(r => r.source === records[0].source ? where(r) : `${where(r)} (${r.source})`).join("; ")}.`,
    excerpt: excerpt(sentence),
  }));
}

const NAME = String.raw`([A-Za-z][A-Za-z0-9]*(?:[_-][A-Za-z0-9]+)*)`;
/** Explicit tool or skill wording: any name shape counts. */
const explicit = [
  new RegExp(String.raw`\x60${NAME}\x60\s+(?:tool|skill)s?\b`, "g"),
  new RegExp(String.raw`\b(?:the|a)\s+(?:tool|skill)\s+\x60${NAME}\x60`, "gi"),
  new RegExp(String.raw`\bload\s+(?:the\s+)?\x60${NAME}\x60`, "gi"),
];
/** Verb wording: only compound names (snake, kebab, or camel case), since plain words are often shell commands. */
const verbal = new RegExp(String.raw`\b(?:use|call|invoke|run)\s+(?:the\s+)?\x60${NAME}\x60`, "gi");
const compound = (name: string) => /[_-]/.test(name) || /[a-z][A-Z]/.test(name);

export function unknownReferenceRule(inventory: Inventory, allow: string[] = []): Finding[] {
  const known = new Set([...inventory.activeTools, ...inventory.skills, ...allow]);
  const findings: Finding[] = [];
  for (const r of inventory.records) {
    const names = new Set<string>();
    for (const pattern of explicit) for (const match of r.text.matchAll(pattern)) names.add(match[1]);
    for (const match of r.text.matchAll(verbal)) if (compound(match[1])) names.add(match[1]);
    for (const name of names) {
      if (known.has(name)) continue;
      const at = r.text.indexOf(`\`${name}\``);
      findings.push({
        rule: "unknown-reference", severity: "warning", source: r.source, channel: r.channel, tool: r.tool,
        message: `\`${name}\` reads as a tool or skill name, but no active tool or loaded skill has that name.`,
        excerpt: excerpt(r.text.slice(Math.max(0, at - 50), at + name.length + 50)),
      });
    }
  }
  return findings;
}

export function guidelineNamesToolRule(inventory: Inventory): Finding[] {
  const findings: Finding[] = [];
  for (const r of inventory.records) {
    if (r.channel !== "prompt-guideline" || !r.tool) continue;
    const problem = /\bthis tool\b/i.test(r.text) ? "says \"this tool\"" : !r.text.includes(r.tool) ? `does not name \`${r.tool}\`` : undefined;
    if (problem) findings.push({
      rule: "guideline-names-tool", severity: "error", source: r.source, channel: r.channel, tool: r.tool,
      message: `Guideline ${problem}; Pi lists guidelines without a tool prefix, so each one must name its tool.`,
      excerpt: excerpt(r.text),
    });
  }
  return findings;
}

export function lintInventory(inventory: Inventory, options: LintOptions = {}): LintResult {
  return {
    inventory,
    totals: totals(inventory),
    findings: [
      ...budgetRule(inventory, options.budget),
      ...duplicateSentenceRule(inventory),
      ...unknownReferenceRule(inventory, options.allow),
      ...guidelineNamesToolRule(inventory),
    ],
  };
}
