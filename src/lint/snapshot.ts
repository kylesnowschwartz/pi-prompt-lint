import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import type { Inventory, InventoryRecord } from "./inventory.ts";

export interface SnapshotEntry { channel: string; source: string; tool?: string; name?: string; alwaysOn: boolean; characters: number; text: string }

/** Inventory records with sources relative to the snapshot file, so the file is portable. */
export function snapshotEntries(inventory: Inventory, snapshotPath: string): SnapshotEntry[] {
  const base = dirname(snapshotPath);
  return inventory.records.map((r: InventoryRecord) => ({
    channel: r.channel, source: r.source.startsWith("/") ? relative(base, r.source) : r.source,
    ...(r.tool ? { tool: r.tool } : {}), ...(r.name ? { name: r.name } : {}),
    alwaysOn: r.alwaysOn, characters: r.characters, text: r.text,
  }));
}

const key = (e: SnapshotEntry) => [e.source, e.channel, e.tool ?? "", e.name ?? ""].join(" | ");
const indent = (text: string, prefix: string) => text.split("\n").map(line => `${prefix}${line}`).join("\n");

/** Readable difference between two snapshots; empty when they match. */
export function diffSnapshots(expected: SnapshotEntry[], actual: SnapshotEntry[]): string {
  const group = (entries: SnapshotEntry[]) => {
    const map = new Map<string, SnapshotEntry[]>();
    for (const e of entries) map.set(key(e), [...(map.get(key(e)) ?? []), e]);
    return map;
  };
  const before = group(expected), after = group(actual);
  const out: string[] = [];
  for (const k of new Set([...before.keys(), ...after.keys()])) {
    const a = before.get(k) ?? [], b = after.get(k) ?? [];
    const removed = a.filter(e => !b.some(x => JSON.stringify(x) === JSON.stringify(e)));
    const added = b.filter(e => !a.some(x => JSON.stringify(x) === JSON.stringify(e)));
    if (!removed.length && !added.length) continue;
    out.push(`@@ ${k}`);
    for (const e of removed) out.push(indent(e.text, "- ") + `\n  (${e.characters} characters, alwaysOn ${e.alwaysOn})`);
    for (const e of added) out.push(indent(e.text, "+ ") + `\n  (${e.characters} characters, alwaysOn ${e.alwaysOn})`);
  }
  return out.join("\n");
}

export interface SnapshotResult { updated: boolean; diff: string }

/** Writes the snapshot when `update` is true or the file is missing; otherwise returns the difference. */
export async function compareSnapshot(inventory: Inventory, snapshotPath: string, update = false): Promise<SnapshotResult> {
  const actual = snapshotEntries(inventory, snapshotPath);
  let existing: string | undefined;
  try { existing = await readFile(snapshotPath, "utf8"); } catch (error: any) { if (error?.code !== "ENOENT") throw error; }
  if (update || existing === undefined) {
    await mkdir(dirname(snapshotPath), { recursive: true });
    await writeFile(snapshotPath, `${JSON.stringify(actual, null, 2)}\n`);
    return { updated: true, diff: "" };
  }
  return { updated: false, diff: diffSnapshots(JSON.parse(existing) as SnapshotEntry[], actual) };
}
