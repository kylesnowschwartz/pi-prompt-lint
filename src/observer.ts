import { AsyncLocalStorage } from "node:async_hooks";
import { ExtensionRunner } from "@earendil-works/pi-coding-agent";
import { getCurrentSystemPrompt, getCurrentTools } from "@earendil-works/pi-ai";

export type ObserverStage = "before_agent_start" | "context_with_system" | "before_provider_request";
export interface PromptSnapshot {
  prompt?: string;
  tools?: unknown[];
  /** Exact provider instruction text blocks; no invented joining separators. */
  instructionBlocks?: string[];
  /** Prompt-building inputs only, never trigger messages or conversation. */
  structured?: Record<string, unknown>;
  warning?: string;
}
export interface ObserverEvent {
  stage: ObserverStage;
  phase: "handler" | "endpoint" | "unattributed" | "warning";
  source?: { path: string; name?: string };
  before?: PromptSnapshot;
  after?: PromptSnapshot;
  /** Proposal only: the runner has NOT applied this at handler exit. */
  returnedPrompt?: string;
  /** Sanitized returned transformation, still separate from in-place mutation. */
  returned?: PromptSnapshot;
  threw?: boolean;
  warning?: string;
  label: "compiled prompt" | "context snapshot" | "provider snapshot (not wire)";
}
export interface ObserverOptions {
  version: string;
  /** Pass handler => pi.on("before_agent_start", handler). Pi wraps handler identity. */
  registerMarker: (handler: () => void) => (() => void);
  listener: (event: ObserverEvent) => void;
}
export interface ObserverHandle { installed: boolean; dispose(): void }

type Fn = (...args: any[]) => any;
type Ext = { path: string; handlers: Map<string, Fn[]> };
type Frame = {
  runner: object;
  arrays: Map<Fn[], { ext: Ext; stage: ObserverStage }>;
  send: (event: ObserverEvent) => void;
  getPrompt?: () => string;
  last?: PromptSnapshot;
  overlap?: boolean;
};
type Subscription = ObserverOptions & { active: boolean };
const methods = {
  emitBeforeAgentStart: "before_agent_start",
  emitContext: "context_with_system",
  emitBeforeProviderRequest: "before_provider_request",
} as const;
const label = (stage: ObserverStage): ObserverEvent["label"] => stage === "before_agent_start"
  ? "compiled prompt" : stage === "context_with_system" ? "context snapshot" : "provider snapshot (not wire)";

// Symbol ownership survives extension module reloads; separate installed SDK copies stay separate.
const owner = Symbol.for("pi-prompt-lint.observer.1.5.2.v1");
interface Bridge {
  subscriptions: Set<Subscription>;
  bind(sub: Subscription): void;
  dispose(): void;
}

/** Clone ONLY already-selected instruction/tool data. Never pass payloads/messages here. */
function copy(value: any, seen = new Set<object>()): any {
  if (value === null || ["string", "number", "boolean", "undefined"].includes(typeof value)) return value;
  if (typeof value !== "object" || seen.has(value)) throw new Error("unsupported instruction/schema value");
  seen.add(value);
  try {
    const result: any = Array.isArray(value) ? [] : {};
    for (const key of Object.keys(value)) {
      const d = Object.getOwnPropertyDescriptor(value, key)!;
      if (!("value" in d)) throw new Error("accessor in instruction/schema value");
      Object.defineProperty(result, key, { value: copy(d.value, seen), enumerable: true, writable: true, configurable: true });
    }
    return result;
  } finally { seen.delete(value); }
}
const optionKeys = ["customPrompt", "forceSystemPrompt", "selectedTools", "hiddenTools", "toolSnippets", "toolGuidelines", "promptGuidelines", "appendSystemPrompt", "sections", "cwd", "contextFiles", "skills"];
function promptInput(event: any): PromptSnapshot {
  const structured: Record<string, unknown> = {};
  for (const key of optionKeys) structured[key] = copy(event.systemPromptOptions[key]);
  return { prompt: event.systemPrompt, structured };
}
function context(messages: any): PromptSnapshot {
  if (!Array.isArray(messages)) return { warning: "Unknown context shape" };
  return { prompt: getCurrentSystemPrompt(messages), tools: copy(getCurrentTools(messages)) };
}
function textBlocks(value: any): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.filter((part) => part?.type === "text" && typeof part.text === "string").map((part) => part.text);
  return [];
}
function provider(payload: any): PromptSnapshot {
  if (!payload || typeof payload !== "object") return { warning: "Unknown provider payload shape" };
  let instructionBlocks: string[] = [];
  // Known OpenAI Responses, Anthropic, Google, and OpenAI Chat payload fields only.
  if (typeof payload.instructions === "string") instructionBlocks = [payload.instructions];
  else if (payload.system !== undefined) instructionBlocks = textBlocks(payload.system);
  else if (Array.isArray(payload.systemInstruction?.parts)) instructionBlocks = payload.systemInstruction.parts.filter((p: any) => typeof p.text === "string").map((p: any) => p.text);
  else if (Array.isArray(payload.messages)) instructionBlocks = payload.messages.filter((m: any) => m?.role === "system" || m?.role === "developer").flatMap((m: any) => textBlocks(m.content));
  const tools = Array.isArray(payload.tools) ? copy(payload.tools) : undefined;
  return { prompt: instructionBlocks.length === 1 ? instructionBlocks[0] : undefined, instructionBlocks, tools,
    ...(instructionBlocks.length !== 1 ? { warning: instructionBlocks.length ? "Multiple provider instruction blocks shown separately without joining or positional ownership assumptions" : "Instructions absent or unknown provider shape; snapshot may be incremental" } : {}) };
}
function safe(snapshot: () => PromptSnapshot): PromptSnapshot {
  try { return snapshot(); } catch { return { warning: "Instruction/schema snapshot unavailable" }; }
}
function deliver(sub: Subscription, event: ObserverEvent) {
  if (!sub.active) return;
  try { sub.listener(copy(event)); } catch { /* Diagnostic listeners cannot interrupt Pi. */ }
}

/** Unsupported internal bridge, deliberately pinned to Pi 1.5.2. Dispose on session_shutdown. */
export function installObserver(options: ObserverOptions): ObserverHandle {
  const proto = ExtensionRunner.prototype as any;
  const sub: Subscription = { ...options, active: true };
  const fail = (warning: string): ObserverHandle => {
    deliver(sub, { stage: "before_agent_start", phase: "warning", label: "compiled prompt", warning });
    return { installed: false, dispose() {} };
  };
  if (options.version !== "1.5.2") return fail("Observer requires Pi 1.5.2; internal observation disabled");
  if (typeof options.registerMarker !== "function") return fail("Runner identity marker required");
  if (!Object.keys(methods).every((key) => typeof proto[key] === "function" && Object.getOwnPropertyDescriptor(proto, key)?.configurable)) return fail("Unsupported ExtensionRunner shape");
  let bridge: Bridge = proto[owner];
  if (!bridge) {
    const subscriptions = new Set<Subscription>();
    const local = new AsyncLocalStorage<Frame>();
    const handlerLocal = new AsyncLocalStorage<Ext>();
    const bindings = new WeakMap<object, WeakMap<Subscription, Ext>>();
    const activeFrames = new WeakMap<object, Set<Frame>>();
    const leases = new Map<Fn[], { count: number; descriptor?: PropertyDescriptor; wrapper: Fn }>();
    const originals = new Map<string, PropertyDescriptor>();
    const wrappers = new Map<string, Fn>();
    const release = (array: Fn[]) => {
      const lease = leases.get(array)!;
      if (--lease.count) return;
      if (Object.getOwnPropertyDescriptor(array, "slice")?.value === lease.wrapper) {
        if (lease.descriptor) Object.defineProperty(array, "slice", lease.descriptor);
        else delete (array as any).slice;
      }
      leases.delete(array);
    };
    const acquire = (array: Fn[]) => {
      const existing = leases.get(array);
      if (existing) { existing.count++; return; }
      const descriptor = Object.getOwnPropertyDescriptor(array, "slice");
      if ((descriptor && (!descriptor.configurable || descriptor.value !== Array.prototype.slice)) || (!descriptor && array.slice !== Array.prototype.slice)) throw new Error("foreign slice");
      const wrapper = function(this: Fn[], ...args: any[]) {
        const snapshot: Fn[] = Reflect.apply(Array.prototype.slice, this, args);
        const frame = local.getStore();
        const binding = frame?.arrays.get(this);
        if (!frame || !binding) return snapshot;
        const { stage, ext } = binding;
        return snapshot.map((handler) => async function(this: unknown, ...handlerArgs: any[]) {
          const event = handlerArgs[0];
          const read = () => stage === "before_agent_start" ? promptInput(event) : stage === "context_with_system" ? context(event.messages) : provider(event.payload);
          if (stage === "before_agent_start") frame.getPrompt = handlerArgs[1].getSystemPrompt;
          const before = safe(read);
          if (stage === "context_with_system" && frame.last && JSON.stringify(frame.last) !== JSON.stringify(before)) {
            frame.send({ stage, phase: "unattributed", label: label(stage), before: frame.last, after: before, warning: "Unexplained change before captured handler; attribution partial" });
          }
          let result: any;
          let threw = true;
          try {
            result = await handlerLocal.run(ext, () => Reflect.apply(handler, this, handlerArgs));
            threw = false;
            return result;
          } finally {
            const after = safe(read);
            frame.last = stage === "context_with_system" && !threw && result?.messages
              ? safe(() => context(result.messages)) : stage === "before_provider_request" && !threw && result !== undefined
              ? safe(() => provider(result)) : after;
            frame.send({ stage, phase: "handler", label: label(stage), source: { path: ext.path }, before, after,
              ...(stage === "before_agent_start" && !threw && typeof result?.systemPrompt === "string" ? { returnedPrompt: result.systemPrompt } : {}),
              ...(!threw && ((stage === "context_with_system" && result?.messages) || (stage === "before_provider_request" && result !== undefined)) ? { returned: frame.last } : {}), threw });
          }
        });
      };
      Object.defineProperty(array, "slice", { value: wrapper, configurable: true, writable: true });
      leases.set(array, { count: 1, descriptor, wrapper });
    };
    for (const [method, stage] of Object.entries(methods) as [keyof typeof methods, ObserverStage][]) {
      const descriptor = Object.getOwnPropertyDescriptor(proto, method)!;
      originals.set(method, descriptor);
      const original = descriptor.value;
      const wrapper = function(this: any, ...args: any[]) {
        const extensions: Ext[] = this.extensions;
        if (!Array.isArray(extensions) || !extensions.every((ext) => ext.handlers instanceof Map && typeof ext.path === "string")) return Reflect.apply(original, this, args);
        const routed = () => [...subscriptions].filter((s) => {
          const ext = bindings.get(this)?.get(s);
          return s.active && ext !== undefined && extensions.includes(ext);
        });
        if (stage !== "before_agent_start" && !routed().length) return Reflect.apply(original, this, args);
        // First emission is buffered until the real marker executes, even if loaded last.
        // Buffers contain only sanitized instruction/schema records, never request state.
        const pending: ObserverEvent[] = [];
        const frame: Frame = { runner: this, arrays: new Map(), send: (event) => { pending.push(event); },
          ...(stage === "context_with_system" ? { last: safe(() => context(args[0])) } : {}) };
        const active = activeFrames.get(this) ?? new Set<Frame>();
        if (active.size) { frame.overlap = true; for (const previous of active) previous.overlap = true; }
        active.add(frame); activeFrames.set(this, active);
        return local.run(frame, async () => {
          const acquired: Fn[][] = [];
          try {
            for (const ext of extensions) {
              const array = ext.handlers.get(stage);
              if (!array) continue;
              if (!Array.isArray(array) || !array.every((h) => typeof h === "function") || frame.arrays.has(array)) throw new Error("unsupported handler array");
              acquire(array); acquired.push(array); frame.arrays.set(array, { ext, stage });
            }
          } catch {
            for (const array of acquired) release(array);
            frame.arrays.clear(); acquired.length = 0;
            frame.send({ stage, phase: "warning", label: label(stage), warning: "Handler observation unavailable; endpoint only" });
          }
          try {
            const result: any = await Reflect.apply(original, this, args);
            const after = safe(() => stage === "before_agent_start"
              ? { prompt: frame.getPrompt?.(), structured: Object.fromEntries(optionKeys.map((key) => [key, copy(result.systemPromptOptions[key])])) }
              : stage === "context_with_system" ? context(result) : provider(result));
            if (stage === "context_with_system" && JSON.stringify(frame.last ?? safe(() => context(args[0]))) !== JSON.stringify(after)) {
              frame.send({ stage, phase: "unattributed", label: label(stage), before: frame.last, after, warning: "Unexplained context endpoint change (including newly registered cross-phase arrays); attribution partial" });
            }
            frame.send({ stage, phase: "endpoint", label: label(stage), after });
            return result;
          } finally {
            for (const array of acquired) release(array);
            active.delete(frame);
            for (const event of pending) for (const s of routed()) deliver(s, frame.overlap ? { ...event, source: undefined, warning: "Concurrent/reentrant dispatch on the same runner: handler ownership disabled; endpoint snapshots retained" } : event);
          }
        });
      };
      wrappers.set(method, wrapper);
      Object.defineProperty(proto, method, { ...descriptor, value: wrapper });
    }
    bridge = { subscriptions, bind(sub) {
      const frame = local.getStore();
      const ext = handlerLocal.getStore();
      if (!frame || !ext) return;
      let map = bindings.get(frame.runner);
      if (!map) bindings.set(frame.runner, map = new WeakMap());
      map.set(sub, ext);
    }, dispose() {
      for (const [method, descriptor] of originals) if (proto[method] === wrappers.get(method)) Object.defineProperty(proto, method, descriptor);
      if (proto[owner] === bridge) delete proto[owner];
    } };
    Object.defineProperty(proto, owner, { value: bridge, configurable: true });
  }
  bridge.subscriptions.add(sub);
  let unsubscribe: () => void;
  try { unsubscribe = options.registerMarker(() => bridge.bind(sub)); }
  catch {
    bridge.subscriptions.delete(sub);
    if (!bridge.subscriptions.size) bridge.dispose();
    return fail("Could not register runner identity marker");
  }
  return { installed: true, dispose() {
    if (!sub.active) return;
    sub.active = false; bridge.subscriptions.delete(sub);
    try { unsubscribe(); } finally { if (!bridge.subscriptions.size) bridge.dispose(); }
  } };
}
