import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import { agentFileProblem, DEFAULT_AGENT_FILES } from "./agent-files.ts";
import { installObserver, type ObserverEvent } from "../observer.ts";

export type Channel =
  | "tool-description"
  | "parameter-descriptions"
  | "prompt-snippet"
  | "prompt-guideline"
  | "system-prompt-section"
  | "system-prompt-guideline"
  | "system-prompt-append"
  | "system-prompt-replacement"
  | "skill";

export interface InventoryRecord {
  channel: Channel;
  /** Extension path as Pi loaded it. */
  source: string;
  tool?: string;
  /** Section key for `system-prompt-section`, skill name for `skill`. */
  name?: string;
  text: string;
  characters: number;
  /** Sent with every request while the session runs with its default tool selection. */
  alwaysOn: boolean;
}

export interface Inventory {
  piVersion: string;
  extensions: string[];
  activeTools: string[];
  skills: string[];
  records: InventoryRecord[];
  /** Extension UI methods called during the offline run; each one is a no-op there. */
  uiCalls?: string[];
}

export interface InventoryOptions {
  /** Working directory for the offline session; a fresh temporary directory by default. */
  cwd?: string;
  /** Point HOME at an empty temporary folder while extensions run. */
  isolateHome?: boolean;
  /** Extra top-level files of the real agent folder to copy into the throwaway one, besides settings.json. */
  agentFiles?: string[];
}

const AGENT_DIR_ENV = "PI_CODING_AGENT_DIR", SESSION_DIR_ENV = "PI_CODING_AGENT_SESSION_DIR";
/**
 * Points Pi's agent and session folders (and HOME when asked) at throwaway folders inside
 * `directory` until the returned function runs. Extensions that resolve paths with
 * getAgentDir() see copies of DEFAULT_AGENT_FILES and `extraFiles` only, and write only the copies.
 */
async function isolate(directory: string, isolateHome: boolean, extraFiles: string[]): Promise<() => void> {
  const realAgentDir = getAgentDir();
  const agentDir = join(directory, "agent"), home = join(directory, "home");
  await mkdir(join(agentDir, "sessions"), { recursive: true });
  await mkdir(home);
  for (const name of new Set([...DEFAULT_AGENT_FILES, ...extraFiles])) {
    await copyFile(join(realAgentDir, name), join(agentDir, name)).catch(() => {});
  }
  const saved = { [AGENT_DIR_ENV]: process.env[AGENT_DIR_ENV], [SESSION_DIR_ENV]: process.env[SESSION_DIR_ENV], HOME: process.env.HOME };
  process.env[AGENT_DIR_ENV] = agentDir;
  process.env[SESSION_DIR_ENV] = join(agentDir, "sessions");
  if (isolateHome) process.env.HOME = home;
  return () => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  };
}

/**
 * An extension UI context with every method of Pi's own no-UI context, each a no-op that
 * records its name. Pi's no-UI context comes from a runner before any UI is bound, so the
 * method set matches the loaded Pi version.
 */
function offlineUI(noUI: Record<string, unknown>, calls: Set<string>): object {
  const ui: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(noUI))) {
    const original = descriptor.value;
    if (typeof original !== "function") { Object.defineProperty(ui, key, descriptor); continue; }
    ui[key] = (...args: unknown[]) => { if (key !== "notify") calls.add(key); return original(...args); };
  }
  return ui;
}

const PROVIDER = "prompt-lint-offline";
const INTERNAL = "prompt-lint-harness";

/** In-process provider: answers every request locally, without transport or credentials. */
function harness(onLoad: (pi: ExtensionAPI) => void) {
  return (pi: ExtensionAPI): void => {
    onLoad(pi);
    pi.registerProvider(PROVIDER, {
      api: `${PROVIDER}-api`, baseUrl: "http://127.0.0.1:1/never-used", apiKey: "offline",
      models: [{ id: "offline", name: "Prompt lint offline model", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 0, maxTokens: 1000 }],
      streamSimple(model) {
        const stream = createAssistantMessageEventStream();
        const message: AssistantMessage = {
          role: "assistant", content: [{ type: "text", text: "offline" }],
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
          usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message }); stream.end(); });
        return stream;
      },
    });
  };
}

/** Every `description` string inside a JSON schema, depth first, in key order. */
export function schemaDescriptions(schema: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown) => {
    if (Array.isArray(value)) { value.forEach(walk); return; }
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (key === "description" && typeof child === "string") found.push(child);
      else walk(child);
    }
  };
  walk(schema);
  return found;
}

const record = (entry: Omit<InventoryRecord, "characters">): InventoryRecord => ({ ...entry, characters: entry.text.length });

/** Text the extension's before_agent_start handler adds, from the observer's structured before/after inputs. */
function promptEdits(event: ObserverEvent): InventoryRecord[] {
  const source = event.source?.path;
  const before = event.before?.structured, after = event.after?.structured;
  if (!source || !before || !after) return [];
  const result: InventoryRecord[] = [];
  const beforeSections = (before.sections ?? {}) as Record<string, string>;
  for (const [name, text] of Object.entries((after.sections ?? {}) as Record<string, string>)) {
    if (typeof text === "string" && text && beforeSections[name] !== text) result.push(record({ channel: "system-prompt-section", source, name, text, alwaysOn: true }));
  }
  const previous = new Set((before.promptGuidelines ?? []) as string[]);
  for (const text of (after.promptGuidelines ?? []) as string[]) {
    if (!previous.has(text)) result.push(record({ channel: "system-prompt-guideline", source, text, alwaysOn: true }));
  }
  const appended = after.appendSystemPrompt, prior = before.appendSystemPrompt;
  if (typeof appended === "string" && appended !== prior) {
    const text = typeof prior === "string" && appended.startsWith(prior) ? appended.slice(prior.length) : appended;
    if (text.trim()) result.push(record({ channel: "system-prompt-append", source, text, alwaysOn: true }));
  }
  if (event.returnedPrompt !== undefined && event.returnedPrompt !== event.before?.prompt) {
    const known = new Set((event.before?.prompt ?? "").split("\n"));
    const text = event.returnedPrompt.split("\n").filter(line => line.trim() && !known.has(line)).join("\n");
    if (text) result.push(record({ channel: "system-prompt-replacement", source, text, alwaysOn: true }));
  }
  return result;
}

/**
 * Loads the given extension entry files into an offline Pi session, runs one local turn so
 * before_agent_start handlers fire, and lists the model-visible text each extension contributes.
 */
export async function collectInventory(entries: string[], options: InventoryOptions = {}): Promise<Inventory> {
  if (!entries.length) throw new Error("collectInventory needs at least one extension entry path");
  const problem = (options.agentFiles ?? []).map(agentFileProblem).find(Boolean);
  if (problem) throw new Error(problem);
  const paths = entries.map(entry => resolve(entry));
  const directory = await mkdtemp(join(tmpdir(), "prompt-lint-"));
  const restore = await isolate(directory, options.isolateHome ?? false, options.agentFiles ?? []);
  const uiCalls = new Set<string>();
  const cwd = options.cwd ?? directory;
  const events: ObserverEvent[] = [];
  let observer: { dispose(): void } | undefined;
  const settings = SettingsManager.inMemory({ defaultProvider: PROVIDER, defaultModel: "offline", compaction: { enabled: false }, retry: { enabled: false } });
  const runtime = await ModelRuntime.create({ authPath: join(directory, "auth.json"), modelsPath: null, modelsStorePath: join(directory, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
  const loader = new DefaultResourceLoader({
    cwd, agentDir: directory, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    appendSystemPromptOverride: () => [], additionalExtensionPaths: paths,
    extensionFactories: [{ name: INTERNAL, factory: harness(pi => {
      observer = installObserver({ version: VERSION, registerMarker: handler => pi.on("before_agent_start", handler), listener: event => events.push(event) });
    }) }],
  });
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    await loader.reload();
    const loadErrors = loader.getExtensions().errors;
    if (loadErrors.length) throw new Error(loadErrors.map(error => `${error.path}: ${error.error}`).join("\n"));
    ({ session } = await createAgentSession({ cwd, agentDir: directory, modelRuntime: runtime, resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd) }));
    const runnerErrors: string[] = [];
    const noUI = session.extensionRunner.getUIContext() as unknown as Record<string, unknown>;
    await session.bindExtensions({ mode: "rpc", uiContext: offlineUI(noUI, uiCalls) as any, onError: error => runnerErrors.push(`${error.extensionPath}: ${error.error}`) });
    const model = runtime.getModel(PROVIDER, "offline");
    if (!model) throw new Error("Offline model was not registered");
    await session.setModel(model);
    await session.prompt("prompt lint inventory turn");
    if (runnerErrors.length) throw new Error(runnerErrors.join("\n"));

    const extensions = loader.getExtensions().extensions.filter(ext => !ext.path.includes(INTERNAL));
    const activeTools = session.getActiveToolNames();
    const active = new Set(activeTools);
    const records: InventoryRecord[] = [];
    for (const ext of extensions) {
      for (const [name, { definition }] of ext.tools) {
        const alwaysOn = active.has(name);
        const add = (channel: Channel, text: string | undefined) => { if (text?.trim()) records.push(record({ channel, source: ext.path, tool: name, text, alwaysOn })); };
        add("tool-description", definition.description);
        add("parameter-descriptions", schemaDescriptions(definition.parameters).join("\n"));
        add("prompt-snippet", definition.promptSnippet);
        for (const guideline of definition.promptGuidelines ?? []) add("prompt-guideline", guideline);
      }
    }
    const known = new Set(extensions.map(ext => ext.path));
    for (const event of events) {
      if (event.stage === "before_agent_start" && event.phase === "handler" && event.source && known.has(event.source.path)) records.push(...promptEdits(event));
    }
    const skills = loader.getSkills().skills;
    for (const skill of skills) {
      // Package-manifest skills sit under the package directory the caller passed;
      // resources_discover skills carry the extension file's folder as baseDir.
      const base = skill.sourceInfo.baseDir;
      const pkg = paths.find(path => skill.filePath.startsWith(path + sep));
      const owner = (pkg ? extensions.find(ext => ext.path.startsWith(pkg + sep)) : undefined)
        ?? extensions.find(ext => base !== undefined && dirname(ext.path) === base)
        ?? (extensions.length === 1 ? extensions[0] : undefined);
      records.push(record({ channel: "skill", source: owner?.path ?? skill.sourceInfo.path, name: skill.name, text: `${skill.name}: ${skill.description}`, alwaysOn: !skill.disableModelInvocation && active.has("read") }));
    }
    return { piVersion: VERSION, extensions: extensions.map(ext => ext.path), activeTools, skills: skills.map(skill => skill.name), records, uiCalls: [...uiCalls].sort() };
  } finally {
    if (session) {
      await (session as any)._extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }).catch(() => {});
      session.dispose();
    }
    observer?.dispose();
    restore();
    await rm(directory, { recursive: true, force: true });
  }
}
