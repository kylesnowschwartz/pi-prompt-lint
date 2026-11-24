import assert from "node:assert/strict";
import { test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ExtensionRunner, createExtensionRuntime, createEventBus, SessionManager } from "@earendil-works/pi-coding-agent";
import { installObserver, type ObserverEvent, type ObserverHandle } from "../src/observer.ts";

const root = dirname(fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent")));
const internals = Promise.all([
  import(pathToFileURL(join(root, "core/extensions/loader.js")).href),
  import(pathToFileURL(join(root, "core/system-prompt.js")).href),
]);
const trigger = { messageType: "user", prompt: "PRIVATE CONVERSATION" } as const;
const options = () => ({ cwd: "/synthetic", customPrompt: "BASE", sections: {} });
async function fixture(factories: any[], observe = true, listener?: (event: ObserverEvent) => void) {
  const [{ loadExtensionFromFactory }] = await internals;
  const runtime = createExtensionRuntime();
  const bus = createEventBus();
  const events: ObserverEvent[] = [];
  let handle: ObserverHandle | undefined;
  let api: any;
  const observer = (pi: any) => {
    api = pi;
    if (observe) handle = installObserver({ version: "1.5.2", registerMarker: (h) => pi.on("before_agent_start", h), listener: (e) => { events.push(e); listener?.(e); } });
    pi.on("session_shutdown", () => handle?.dispose());
  };
  const extensions = [];
  for (const [i, factory] of [...factories, observer].entries()) extensions.push(await loadExtensionFromFactory(factory, "/synthetic", bus, runtime, `/synthetic/${i}.ts`));
  const runner = new ExtensionRunner(extensions, runtime, "/synthetic", SessionManager.inMemory(), {} as any);
  return { runner, events, handle, extensions, api, runtime };
}
const endpoint = (events: ObserverEvent[], stage: string) => events.filter((e) => e.stage === stage && e.phase === "endpoint").at(-1)!;

test("version guard does not patch", () => {
  const before = ExtensionRunner.prototype.emitBeforeAgentStart;
  const events: ObserverEvent[] = [];
  const handle = installObserver({ version: "1.5.3", registerMarker() { throw Error("must not register"); }, listener: (e) => events.push(e) });
  assert.equal(handle.installed, false);
  assert.match(events[0].warning!, /1.5.2/);
  assert.equal(ExtensionRunner.prototype.emitBeforeAgentStart, before);
});

test("actual loader/runner: same outputs, calls, errors; structured mutation, override proposal and unsubscribe", async () => {
  async function run(observe: boolean) {
    const calls: string[] = [];
    const factories = [(pi: any) => {
      const off = pi.on("before_agent_start", (event: any, ctx: any) => {
        calls.push("self:" + ctx.getSystemPrompt()); off();
        pi.on("before_agent_start", (e: any) => { calls.push("late"); e.systemPromptOptions.sections.late = "LATE"; });
        event.systemPromptOptions.sections.first = "FIRST";
      });
      pi.on("before_agent_start", (e: any) => { calls.push("throw"); e.systemPromptOptions.sections.survives = "SURVIVES"; throw Error("synthetic"); });
    }, (pi: any) => {
      pi.on("before_agent_start", (e: any) => { calls.push("override"); e.systemPromptOptions.promptGuidelines.push("DUP", "DUP"); return { systemPrompt: "OVERRIDE" }; });
      pi.on("before_agent_start", (e: any, ctx: any) => { calls.push("next:" + ctx.getSystemPrompt()); assert.equal(e.systemPromptOptions.forceSystemPrompt, "OVERRIDE"); });
    }];
    const f = await fixture(factories, observe);
    const errors: any[] = [];
    f.runner.onError((e) => errors.push({ event: e.event, error: e.error, extensionPath: e.extensionPath }));
    try {
      const first = await f.runner.emitBeforeAgentStart(trigger, options());
      const second = await f.runner.emitBeforeAgentStart(trigger, options());
      for (const ext of f.extensions) for (const array of ext.handlers.values()) assert.equal(Object.hasOwn(array, "slice"), false);
      return { calls, errors, first, second, events: f.events };
    } finally { f.handle?.dispose(); }
  }
  const baseline = await run(false), observed = await run(true);
  for (const key of ["calls", "errors", "first", "second"] as const) assert.deepEqual(observed[key], baseline[key]);
  const mutations = observed.events.filter((e) => e.phase === "handler");
  const thrown = mutations.find((e) => e.threw)!;
  assert.equal((thrown.after!.structured!.sections as any).survives, "SURVIVES");
  const override = mutations.find((e) => e.returnedPrompt)!;
  assert.equal(override.returnedPrompt, "OVERRIDE");
  assert.notEqual(override.after!.structured!.forceSystemPrompt, "OVERRIDE");
  assert.deepEqual(override.after!.structured!.promptGuidelines, ["DUP", "DUP"]);
  assert.equal(endpoint(observed.events, "before_agent_start").after!.prompt, "OVERRIDE");
  assert.ok(mutations.every((e) => e.source?.path.startsWith("/synthetic/")));
  assert.ok(!JSON.stringify(observed.events).includes("PRIVATE CONVERSATION"));
});

test("compiled endpoint uses actual runner getter without forced replacement", async () => {
  const f = await fixture([(pi: any) => pi.on("before_agent_start", (e: any) => { e.systemPromptOptions.sections.alpha = "A"; })]);
  try {
    const result = await f.runner.emitBeforeAgentStart(trigger, options());
    const [, { buildSystemPrompt }] = await internals;
    assert.equal(endpoint(f.events, "before_agent_start").after!.prompt, buildSystemPrompt(result.systemPromptOptions));
  } finally { f.handle?.dispose(); }
});

test("context gap reconciles unattributed; next invocation attributes new array", async () => {
  const f = await fixture([(pi: any) => {
    let once = false;
    pi.on("context", () => {
      if (!once) pi.on("context_with_system", (e: any) => { e.messages[0].content += " CHANGED"; });
      once = true;
    });
  }]);
  try {
    await f.runner.emitBeforeAgentStart(trigger, options());
    const messages: any = [{ role: "system", content: "HEAD", timestamp: 0 }, { role: "user", content: "PRIVATE", timestamp: 0 }];
    const result = await f.runner.emitContext(messages);
    assert.equal((result[0] as any).content, "HEAD CHANGED");
    assert.ok(f.events.some((e) => e.phase === "unattributed"));
    f.events.length = 0;
    await f.runner.emitContext(messages);
    assert.ok(f.events.some((e) => e.phase === "handler" && e.stage === "context_with_system"));
    assert.ok(!JSON.stringify(f.events).includes("PRIVATE"));
  } finally { f.handle?.dispose(); }
});

test("provider snapshot excludes conversation/auth, preserves full schemas and return identity", async () => {
  const replacement = { instructions: "REPLACED", tools: [{ type: "function", name: "x", parameters: { type: "object", properties: { a: { type: "string", description: "full" } } } }], input: "PRIVATE" };
  const f = await fixture([(pi: any) => {
    pi.on("before_provider_request", (e: any) => { e.payload.instructions = "MUTATED"; throw Error("provider synthetic"); });
    pi.on("before_provider_request", () => replacement);
  }]);
  try {
    await f.runner.emitBeforeAgentStart(trigger, options());
    const payload = { instructions: "INITIAL", input: "PRIVATE", headers: { authorization: "SECRET" } };
    Object.defineProperty(payload, "auth", { get() { throw Error("do not read"); } });
    assert.equal(await f.runner.emitBeforeProviderRequest(payload), replacement);
    const end = endpoint(f.events, "before_provider_request");
    assert.deepEqual(end.after!.tools, replacement.tools);
    replacement.tools[0].parameters.properties.a.description = "later";
    assert.equal((end.after!.tools![0] as any).parameters.properties.a.description, "full");
    assert.match(end.label, /not wire/);
    assert.ok(f.events.some((e) => e.threw && e.after?.prompt === "MUTATED"));
    assert.ok(!/SECRET|PRIVATE|authorization|headers/.test(JSON.stringify(f.events)));
  } finally { f.handle?.dispose(); }
});

test("concurrent runners, overlapping same-runner emissions and reentrancy route independently", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const a = await fixture([(pi: any) => pi.on("before_agent_start", async (e: any) => { if (e.prompt === "wait") await gate; e.systemPromptOptions.sections.a = e.prompt; })]);
  const b = await fixture([(pi: any) => pi.on("before_agent_start", (e: any) => { e.systemPromptOptions.sections.b = "B"; })]);
  try {
    const waiting = a.runner.emitBeforeAgentStart({ ...trigger, prompt: "wait" }, options());
    await b.runner.emitBeforeAgentStart(trigger, options());
    await a.runner.emitBeforeAgentStart({ ...trigger, prompt: "fast" }, options());
    release(); await waiting;
    assert.ok(!JSON.stringify(a.events).includes('"b":"B"'));
    assert.ok(!JSON.stringify(b.events).includes('"a":'));
    assert.ok(a.events.some(e => e.warning?.includes("ownership disabled")));
    assert.ok(a.events.filter(e => e.phase === "handler").every(e => e.source === undefined));
    assert.ok(b.events.some(e => e.phase === "handler" && e.source !== undefined));
    const endpoints = a.events.filter((e) => e.phase === "endpoint");
    assert.equal(endpoints.length, 2);
    assert.equal((endpoints[0].after!.structured!.sections as any).a, "fast");
    assert.equal((endpoints[1].after!.structured!.sections as any).a, "wait");
    let nested = false;
    a.api.on("before_agent_start", async () => { if (!nested) { nested = true; await a.runner.emitBeforeAgentStart({ ...trigger, prompt: "nested" }, options()); } });
    await a.runner.emitBeforeAgentStart({ ...trigger, prompt: "outer" }, options());
    assert.equal(a.events.filter((e) => e.phase === "endpoint").length, 4);
    for (const ext of a.extensions) for (const array of ext.handlers.values()) assert.equal(Object.hasOwn(array, "slice"), false);
  } finally { release(); a.handle?.dispose(); b.handle?.dispose(); }
});

test("shutdown/reload reference ownership, listener failure isolation and factory reuse", async () => {
  const original = ExtensionRunner.prototype.emitContext;
  const a = await fixture([]), b = await fixture([]);
  const patched = ExtensionRunner.prototype.emitContext;
  assert.notEqual(patched, original);
  await a.runner.emit({ type: "session_shutdown", reason: "reload" });
  assert.equal(ExtensionRunner.prototype.emitContext, patched);
  await b.runner.emitBeforeAgentStart(trigger, options());
  await b.runner.emit({ type: "session_shutdown", reason: "quit" });
  assert.equal(ExtensionRunner.prototype.emitContext, original);
  a.handle?.dispose(); b.handle?.dispose();
  const next = await fixture([]);
  const extra = installObserver({ version: "1.5.2", registerMarker: (h) => next.api.on("before_agent_start", h), listener() { throw Error("listener"); } });
  try { await next.runner.emitBeforeAgentStart(trigger, options()); assert.ok(next.events.length); }
  finally { extra.dispose(); next.handle?.dispose(); }
  assert.equal(ExtensionRunner.prototype.emitContext, original);
});

test("original runner rejection identity and own slice descriptors are preserved", async () => {
  const f = await fixture([]);
  try {
    await f.runner.emitBeforeAgentStart(trigger, options());
    const array = f.extensions.at(-1)!.handlers.get("before_agent_start")!;
    Object.defineProperty(array, "slice", { value: Array.prototype.slice, configurable: true, writable: false, enumerable: true });
    const before = Object.getOwnPropertyDescriptor(array, "slice");
    await f.runner.emitBeforeAgentStart(trigger, options());
    assert.deepEqual(Object.getOwnPropertyDescriptor(array, "slice"), before);
    const error = new Error("same rejection");
    const original = f.runner.createContext;
    f.runner.createContext = () => { throw error; };
    await assert.rejects(f.runner.emitBeforeAgentStart(trigger, options()), (caught) => caught === error);
    assert.deepEqual(Object.getOwnPropertyDescriptor(array, "slice"), before);
    f.runner.createContext = original;
  } finally { f.handle?.dispose(); }
});

test("known provider shapes extract only instructions; unknown shapes explicitly partial", async () => {
  const f = await fixture([]);
  try {
    await f.runner.emitBeforeAgentStart(trigger, options());
    for (const [payload, expected] of [
      [{ system: [{ type: "text", text: "ANTHROPIC" }], messages: [{ role: "user", content: "PRIVATE" }] }, "ANTHROPIC"],
      [{ systemInstruction: { parts: [{ text: "GOOGLE" }] }, contents: [{ parts: [{ text: "PRIVATE" }] }] }, "GOOGLE"],
      [{ messages: [{ role: "system", content: "SYSTEM" }, { role: "developer", content: [{ type: "text", text: "DEVELOPER" }] }, { role: "user", content: "PRIVATE" }] }, "SYSTEM\n\nDEVELOPER"],
    ] as const) {
      assert.equal(await f.runner.emitBeforeProviderRequest(payload), payload);
      const captured = endpoint(f.events, "before_provider_request").after!;
      assert.deepEqual(captured.instructionBlocks, expected === "SYSTEM\n\nDEVELOPER" ? ["SYSTEM", "DEVELOPER"] : [expected]);
      assert.equal(captured.prompt, expected === "SYSTEM\n\nDEVELOPER" ? undefined : expected);
    }
    await f.runner.emitBeforeProviderRequest({ contents: "PRIVATE", auth: "SECRET" });
    assert.match(endpoint(f.events, "before_provider_request").after!.warning!, /unknown provider shape/);
    assert.ok(!/PRIVATE|SECRET/.test(JSON.stringify(f.events)));
  } finally { f.handle?.dispose(); }
});

test("new cross-phase array before an existing captured handler is still unattributed", async () => {
  const f = await fixture([(pi: any) => {
    pi.on("context", () => pi.on("context_with_system", (e: any) => { e.messages[0].content += " GAP"; }));
  }, (pi: any) => pi.on("context_with_system", () => {})]);
  try {
    await f.runner.emitBeforeAgentStart(trigger, options());
    await f.runner.emitContext([{ role: "system", content: "HEAD", timestamp: 0 }]);
    assert.ok(f.events.some((e) => e.phase === "unattributed" && e.after?.prompt === "HEAD GAP"));
  } finally { f.handle?.dispose(); }
});
