import assert from "node:assert/strict";
import { test } from "node:test";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findPi, PiNotUsable, SUPPORTED_PI_VERSION } from "../src/lint/pi.ts";

/** A fake global prefix: lib/node_modules/<pi>/{package.json,dist/cli.js,node_modules/<pi-ai>} and bin/pi linked to the cli. */
async function fakePrefix(version = SUPPORTED_PI_VERSION) {
  const prefix = realpathSync(await mkdtemp(join(tmpdir(), "prompt-lint-prefix-")));
  const root = join(prefix, "lib", "node_modules", "@earendil-works", "pi-coding-agent");
  const aiRoot = join(root, "node_modules", "@earendil-works", "pi-ai");
  await mkdir(join(root, "dist"), { recursive: true });
  await mkdir(aiRoot, { recursive: true });
  await mkdir(join(prefix, "bin"));
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version }));
  await writeFile(join(aiRoot, "package.json"), JSON.stringify({ name: "@earendil-works/pi-ai", version }));
  await writeFile(join(root, "dist", "cli.js"), "");
  await chmod(join(root, "dist", "cli.js"), 0o755);
  await symlink("../lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js", join(prefix, "bin", "pi"));
  return { prefix, root, aiRoot, cleanup: () => rm(prefix, { recursive: true, force: true }) };
}

const nowhere = () => mkdtemp(join(tmpdir(), "prompt-lint-nowhere-"));

test("finds pi in node_modules above the linter before PATH", async () => {
  const fake = await fakePrefix();
  try {
    const from = join(fake.prefix, "lib", "node_modules", "linter", "dist");
    await mkdir(from, { recursive: true });
    const pi = findPi({ from, path: "" });
    assert.deepEqual(pi, { root: fake.root, aiRoot: fake.aiRoot, version: SUPPORTED_PI_VERSION, foundBy: "linter install" });
  } finally { await fake.cleanup(); }
});

test("follows the pi executable on PATH to its package root", async () => {
  const fake = await fakePrefix(), from = await nowhere();
  try {
    const pi = findPi({ from, path: ["/no/such/dir", join(fake.prefix, "bin")].join(":") });
    assert.equal(pi.root, fake.root);
    assert.equal(pi.aiRoot, fake.aiRoot);
    assert.equal(pi.foundBy, "pi on PATH");
  } finally { await fake.cleanup(); await rm(from, { recursive: true }); }
});

test("an override wins, as a package root or a folder holding node_modules", async () => {
  const fake = await fakePrefix(), from = await nowhere();
  try {
    assert.equal(findPi({ override: fake.root, from, path: "" }).foundBy, "override");
    assert.equal(findPi({ override: join(fake.prefix, "lib"), from, path: "" }).root, fake.root);
    assert.throws(() => findPi({ override: from, from, path: "" }), PiNotUsable);
  } finally { await fake.cleanup(); await rm(from, { recursive: true }); }
});

test("an unsupported version is an error, never a fallback", async () => {
  const old = await fakePrefix("1.4.0"), good = await fakePrefix(), from = await nowhere();
  try {
    assert.throws(() => findPi({ from, path: [join(old.prefix, "bin"), join(good.prefix, "bin")].join(":") }),
      (error: Error) => error instanceof PiNotUsable && /Pi 1\.4\.0 .* needs Pi 1\.5\.2/.test(error.message));
  } finally { await old.cleanup(); await good.cleanup(); await rm(from, { recursive: true }); }
});

test("no pi anywhere names the override", async () => {
  const from = await nowhere();
  try {
    assert.throws(() => findPi({ from, path: "" }), /not found: install pi, or point --pi or PI_PROMPT_LINT_PI/);
  } finally { await rm(from, { recursive: true }); }
});
