import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertPromptLint, collectInventory, compareSnapshot, lintInventory, type Inventory, type InventoryRecord } from "../src/lint/index.ts";
import { main } from "../src/lint/cli.ts";
import { agentFileProblem } from "../src/lint/agent-files.ts";

const fixture = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const synthetic = fixture("synthetic.ts"), clean = fixture("lint/clean.ts"), problems = fixture("lint/problems.ts");
const inventory = (records: Partial<InventoryRecord>[], extra: Partial<Inventory> = {}): Inventory => ({
  piVersion: "1.5.2", extensions: ["ext"], activeTools: ["read", "my_tool"], skills: ["my-skill"],
  records: records.map(r => ({ channel: "tool-description", source: "ext", tool: "my_tool", alwaysOn: true, text: "", characters: r.text?.length ?? 0, ...r }) as InventoryRecord),
  ...extra,
});
const rules = (inv: Inventory, rule: string, options = {}) => lintInventory(inv, options).findings.filter(f => f.rule === rule);

test("inventory of the synthetic fixture lists every channel it contributes", async () => {
  const inv = await collectInventory([synthetic]);
  assert.deepEqual(inv.extensions, [synthetic]);
  assert.deepEqual(inv.activeTools, ["read", "bash", "edit", "write", "prompt_fixture"]);
  assert.deepEqual(inv.records.map(r => [r.channel, r.tool ?? r.name, r.text.split("\n")[0], r.characters === r.text.length, r.alwaysOn]), [
    ["tool-description", "prompt_fixture", "Synthetic schema; do not call", true, true],
    ["parameter-descriptions", "prompt_fixture", "Full nested schema", true, true],
    ["prompt-snippet", "prompt_fixture", "Synthetic tool snippet", true, true],
    ["prompt-guideline", "prompt_fixture", "Fixture guideline with literal </script> and <untrusted> tags", true, true],
    ["system-prompt-section", "fixture", "Synthetic before_agent_start addition", true, true],
  ]);
  assert.ok(inv.records.every(r => r.source === synthetic));
  assert.doesNotThrow(() => JSON.parse(JSON.stringify(inv)));
});

test("inventory attributes returned prompts and discovered skills per extension", async () => {
  const inv = await collectInventory([problems, clean]);
  assert.deepEqual(inv.skills, ["fixture-skill"]);
  const skill = inv.records.find(r => r.channel === "skill")!;
  assert.equal(skill.source, problems);
  assert.equal(skill.text, "fixture-skill: Fixture skill advertised by the problems lint fixture.");
  const replacement = inv.records.find(r => r.channel === "system-prompt-replacement")!;
  assert.deepEqual([replacement.source, replacement.text], [problems, "Problems fixture replacement line."]);
  assert.ok(inv.records.some(r => r.source === clean && r.tool === "clean_tool"));
});

test("budget reports only when a limit is given", () => {
  const inv = inventory([{ text: "x".repeat(50) }, { text: "y".repeat(50), alwaysOn: false }]);
  assert.deepEqual(rules(inv, "budget"), []);
  assert.deepEqual(rules(inv, "budget", { budget: 50 }), []);
  const [finding] = rules(inv, "budget", { budget: 49 });
  assert.equal(finding.severity, "error");
  assert.match(finding.message, /50 characters, over the budget of 49/);
  assert.equal(lintInventory(inv).totals[0].alwaysOn, 50);
});

test("duplicate-sentence flags repeated long sentences across entries and extensions only", () => {
  const sentence = "Always check the branch before you write any file.";
  assert.equal(rules(inventory([{ text: `Intro. ${sentence}` }, { channel: "prompt-snippet", text: sentence.toUpperCase().replace(/ /g, "  ") }]), "duplicate-sentence").length, 1);
  assert.equal(rules(inventory([{ text: sentence }, { source: "other", text: `- ${sentence}` }]), "duplicate-sentence").length, 1);
  assert.deepEqual(rules(inventory([{ text: "Read the file first." }, { text: "Read the file first." }]), "duplicate-sentence"), []);
  assert.deepEqual(rules(inventory([{ text: `${sentence} ${sentence}` }]), "duplicate-sentence"), []);
});

test("unknown-reference flags only tool or skill wording for missing names", () => {
  const flagged = (text: string, allow?: string[]) => rules(inventory([{ text }]), "unknown-reference", { allow }).map(f => f.message.match(/`([^`]+)`/)![1]);
  assert.deepEqual(flagged("Call `missing_tool` first."), ["missing_tool"]);
  assert.deepEqual(flagged("Use `SendMessage` to reply."), ["SendMessage"]);
  assert.deepEqual(flagged("Load the `ghost` skill. The `grep` tool helps."), ["ghost", "grep"]);
  assert.deepEqual(flagged("Use `git` or run `rg` here; set `max_items` to 3."), []);
  assert.deepEqual(flagged("Call `my_tool`, use the `read` tool, load the `my-skill` skill."), []);
  assert.deepEqual(flagged("Call `missing_tool` first.", ["missing_tool"]), []);
});

test("guideline-names-tool requires each guideline to name its own tool", () => {
  const guideline = (text: string) => rules(inventory([{ channel: "prompt-guideline", text }]), "guideline-names-tool");
  assert.deepEqual(guideline("Use my_tool for lists."), []);
  assert.equal(guideline("Use this tool for my_tool lists.")[0].severity, "error");
  assert.equal(guideline("Prefer short lists.").length, 1);
  assert.deepEqual(rules(inventory([{ text: "Prefer short lists." }]), "guideline-names-tool"), []);
});

test("CLI prints help, reports findings, and sets exit codes", async () => {
  const run = async (...argv: string[]) => {
    const io = { out: "", err: "" };
    const code = await main(argv, { stdout: t => { io.out += t; }, stderr: t => { io.err += t; }, color: false, env: { PATH: "" } });
    return { code, ...io };
  };
  const help = await run("--help");
  assert.equal(help.code, 0);
  assert.match(help.out, /^Usage: pi-prompt-lint/);
  const version = await run("--version");
  assert.equal(version.code, 0);
  assert.match(version.out, /^pi-prompt-lint \d+\.\d+\.\d+\n$/);
  assert.equal((await run("--budget", "lots", clean)).code, 2);
  const missing = await run(join(tmpdir(), "no-such-extension.ts"));
  assert.equal(missing.code, 2);
  assert.match(missing.err, /Could not load extensions offline/);
  const ok = await run(clean);
  assert.equal(ok.code, 0);
  assert.match(ok.out, /always-on characters: 132/);
  assert.ok(!ok.out.includes("\x1b["));
  assert.equal((await run("--budget", "100", clean)).code, 1);
  const bad = await run("--json", problems);
  assert.equal(bad.code, 1);
  const json = JSON.parse(bad.out);
  assert.deepEqual([...new Set(json.findings.map((f: any) => f.rule))].sort(), ["duplicate-sentence", "guideline-names-tool", "unknown-reference"]);
});

test("assertPromptLint enforces errors, budgets, and snapshots", async () => {
  const directory = await mkdtemp(join(tmpdir(), "prompt-lint-snapshot-"));
  const snapshot = join(directory, "prompt.snapshot.json");
  try {
    await assert.rejects(assertPromptLint([problems]), /guideline-names-tool/);
    await assert.rejects(assertPromptLint([clean], { budget: 10 }), /over the budget of 10/);
    await assertPromptLint([clean], { snapshot });
    const written = JSON.parse(await readFile(snapshot, "utf8"));
    assert.equal(written[0].source.startsWith("/"), false);
    await assertPromptLint([clean], { snapshot });
    written[0].text = "Old description.";
    await writeFile(snapshot, JSON.stringify(written));
    await assert.rejects(assertPromptLint([clean], { snapshot }), (error: Error) =>
      /PI_PROMPT_LINT_UPDATE=1/.test(error.message) && /- Old description\./.test(error.message) && /\+ Returns a fixed word for lint tests\./.test(error.message));
    assert.deepEqual(await compareSnapshot(await collectInventory([clean]), snapshot, true), { updated: true, diff: "" });
    await assertPromptLint([clean], { snapshot });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("CLI lints a package folder, and the current folder when no extension is given", async () => {
  const folder = await mkdtemp(join(tmpdir(), "prompt-lint-package-"));
  try {
    await writeFile(join(folder, "clean.ts"), await readFile(clean, "utf8"));
    await writeFile(join(folder, "package.json"), JSON.stringify({ name: "fixture", pi: { extensions: ["./clean.ts"] } }));
    for (const argv of [[folder], []]) {
      let out = "";
      const code = await main(argv, { stdout: t => { out += t; }, stderr: () => {}, color: false, cwd: folder, env: { PATH: "" } });
      assert.equal(code, 0);
      assert.match(out, /always-on characters: 132/);
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("CLI exits 2 with one line when --pi names an unsupported Pi version", async () => {
  const folder = await mkdtemp(join(tmpdir(), "prompt-lint-fake-pi-"));
  try {
    await writeFile(join(folder, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9" }));
    for (const io of [{ argv: ["--pi", folder, clean], env: { PATH: "" } }, { argv: [clean], env: { PATH: "", PI_PROMPT_LINT_PI: folder } }]) {
      let err = "";
      const code = await main(io.argv, { stdout: () => {}, stderr: t => { err += t; }, color: false, env: io.env });
      assert.equal(code, 2);
      assert.equal(err.trim().split("\n").length, 1);
      assert.match(err, /Pi 9\.9\.9 .* not supported; pi-prompt-lint needs Pi 1\.5\.2\. Point --pi or PI_PROMPT_LINT_PI/);
    }
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("extensions write a throwaway agent folder, not the real one, and offline UI calls are recorded", async () => {
  const real = await mkdtemp(join(tmpdir(), "prompt-lint-real-agent-"));
  const home = await mkdtemp(join(tmpdir(), "prompt-lint-real-home-"));
  const saved = { agent: process.env.PI_CODING_AGENT_DIR, home: process.env.HOME };
  const settings = join(real, "settings.json"), original = JSON.stringify({ theme: "dark" });
  try {
    await writeFile(settings, original);
    process.env.PI_CODING_AGENT_DIR = real;
    process.env.HOME = home;
    const inv = await collectInventory([fixture("lint/writes-agent-dir.ts")], { isolateHome: true });
    assert.equal(await readFile(settings, "utf8"), original);
    await assert.rejects(readFile(join(home, "lint-fixture-home.txt")));
    assert.equal(process.env.PI_CODING_AGENT_DIR, real);
    assert.equal(process.env.HOME, home);
    assert.deepEqual(inv.uiCalls, ["getEditorComponent"]);
  } finally {
    if (saved.agent === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved.agent;
    process.env.HOME = saved.home;
    await rm(real, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});

test("only settings.json and requested agent files reach the throwaway agent folder", async () => {
  const real = await mkdtemp(join(tmpdir(), "prompt-lint-real-agent-"));
  const report = join(real, "..", `${real.split("/").pop()}-report.json`);
  const saved = process.env.PI_CODING_AGENT_DIR;
  try {
    for (const name of ["settings.json", "mcp.json", "mcp-auth.json", "auth.json"]) await writeFile(join(real, name), "{}");
    process.env.PI_CODING_AGENT_DIR = real;
    process.env.PROMPT_LINT_FIXTURE_REPORT = report;
    const listed = async (agentFiles?: string[]) => {
      await collectInventory([fixture("lint/lists-agent-dir.ts")], { agentFiles });
      return JSON.parse(await readFile(report, "utf8"));
    };
    assert.deepEqual(await listed(), ["settings.json"]);
    assert.deepEqual(await listed(["mcp.json"]), ["mcp.json", "settings.json"]);
    await assert.rejects(collectInventory([fixture("lint/lists-agent-dir.ts")], { agentFiles: ["mcp-auth.json"] }), /looks like a credential file/);
    await assert.rejects(collectInventory([fixture("lint/lists-agent-dir.ts")], { agentFiles: ["../auth.json"] }), /without path separators/);
    const errors: string[] = [];
    const code = await main(["--agent-file", "sub/mcp.json", fixture("lint/clean.ts")], { stdout: () => {}, stderr: t => { errors.push(t); }, color: false, env: { PATH: "" } });
    assert.equal(code, 2);
    assert.match(errors.join(""), /without path separators/);
    for (const name of ["keybindings.json", "mcp.json"]) assert.equal(agentFileProblem(name), undefined);
    for (const name of ["auth.json", "api-key.txt", "oauth-tokens.json", "credentials.json", "secrets.json"]) assert.ok(agentFileProblem(name));
  } finally {
    if (saved === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = saved;
    delete process.env.PROMPT_LINT_FIXTURE_REPORT;
    await rm(real, { recursive: true, force: true });
    await rm(report, { force: true });
  }
});
