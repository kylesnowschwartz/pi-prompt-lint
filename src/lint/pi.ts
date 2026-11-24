import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import { delimiter, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** The Pi version whose internals the observer patches. */
export const SUPPORTED_PI_VERSION = "1.5.2";
export const PI_OVERRIDE_ENV = "PI_PROMPT_LINT_PI";

const CODING_AGENT = "@earendil-works/pi-coding-agent";
const AI = "@earendil-works/pi-ai";

export interface PiInstall {
  /** Package root of @earendil-works/pi-coding-agent. */
  root: string;
  /** Package root of the @earendil-works/pi-ai that root depends on. */
  aiRoot: string;
  version: string;
  /** How the install was found. */
  foundBy: "override" | "linter install" | "pi on PATH";
}

export interface FindPiOptions {
  /** `--pi` flag or PI_PROMPT_LINT_PI value: a pi-coding-agent package root, or a folder whose node_modules holds one. */
  override?: string;
  /** Directory the linter runs from; node_modules folders from here upward are searched. */
  from: string;
  /** PATH value searched for a `pi` executable. */
  path?: string;
}

/** Pi cannot be found or is a version the observer does not support. */
export class PiNotUsable extends Error {}

const readJson = (file: string): any => JSON.parse(readFileSync(file, "utf8"));
const isDir = (path: string) => { try { return statSync(path).isDirectory(); } catch { return false; } };

/** Nearest node_modules/<name> package root from `start` upward. */
function findInNodeModules(start: string, name: string): string | undefined {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) return undefined;
  }
}

/** Nearest folder from `start` upward whose package.json is named `name`. */
function findPackageRoot(start: string, name: string): string | undefined {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) { try { if (readJson(manifest).name === name) return dir; } catch { /* not a readable manifest */ } }
    if (dirname(dir) === dir) return undefined;
  }
}

function fromPathEnv(pathEnv: string): string | undefined {
  for (const dir of pathEnv.split(delimiter).filter(Boolean)) {
    const executable = join(dir, "pi");
    if (!existsSync(executable) || isDir(executable)) continue;
    const root = findPackageRoot(dirname(realpathSync(executable)), CODING_AGENT);
    if (root) return root;
  }
  return undefined;
}

function fromOverride(dir: string): string {
  const path = resolve(dir);
  const manifest = join(path, "package.json");
  if (existsSync(manifest)) { try { if (readJson(manifest).name === CODING_AGENT) return realpathSync(path); } catch { /* fall through */ } }
  const nested = findInNodeModules(path, CODING_AGENT);
  if (nested && nested.startsWith(realpathSync(path))) return nested;
  throw new PiNotUsable(`No ${CODING_AGENT} package at ${path} (given by --pi or ${PI_OVERRIDE_ENV}).`);
}

/**
 * Finds the Pi to load: the override when given, else the pi packages resolvable from the
 * linter's own location, else the package behind the `pi` executable on PATH.
 */
export function findPi(options: FindPiOptions): PiInstall {
  let root: string | undefined, foundBy: PiInstall["foundBy"];
  if (options.override) { root = fromOverride(options.override); foundBy = "override"; }
  else {
    root = findInNodeModules(options.from, CODING_AGENT); foundBy = "linter install";
    if (!root) { root = fromPathEnv(options.path ?? ""); foundBy = "pi on PATH"; }
  }
  if (!root) throw new PiNotUsable(`Pi ${SUPPORTED_PI_VERSION} not found: install pi, or point --pi or ${PI_OVERRIDE_ENV} at its package folder.`);
  const version = String(readJson(join(root, "package.json")).version);
  if (version !== SUPPORTED_PI_VERSION) {
    throw new PiNotUsable(`Pi ${version} at ${root} is not supported; pi-prompt-lint needs Pi ${SUPPORTED_PI_VERSION}. Point --pi or ${PI_OVERRIDE_ENV} at a Pi ${SUPPORTED_PI_VERSION} package folder.`);
  }
  const aiRoot = findInNodeModules(root, AI);
  if (!aiRoot) throw new PiNotUsable(`Pi ${version} at ${root} has no ${AI} package next to it.`);
  return { root, aiRoot, version, foundBy };
}

let targets: Record<string, string> | undefined;

/**
 * Makes every later import of the two pi packages, from any module, load them from `pi`.
 * Resolution runs as if from inside each package root, so their own `exports` apply.
 */
export function usePi(pi: PiInstall): void {
  const first = !targets;
  targets = { [CODING_AGENT]: pathToFileURL(join(pi.root, "package.json")).href, [AI]: pathToFileURL(join(pi.aiRoot, "package.json")).href };
  if (!first) return;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      const name = specifier.startsWith(AI) ? AI : specifier.startsWith(CODING_AGENT) ? CODING_AGENT : undefined;
      const parentURL = name && (specifier === name || specifier.startsWith(`${name}/`)) ? targets?.[name] : undefined;
      return nextResolve(specifier, parentURL ? { ...context, parentURL } : context);
    },
  });
}
