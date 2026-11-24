import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type AssistantMessage } from "@earendil-works/pi-ai";

/** Explicit opt-in QA fixture: no transport, credentials, timers, or filesystem access. */
export default function synthetic(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "prompt_fixture", label: "Prompt fixture", description: "Synthetic schema; do not call",
    promptSnippet: "Synthetic tool snippet", promptGuidelines: ["Fixture guideline with literal </script> and <untrusted> tags"],
    parameters: { type: "object", properties: { value: { type: "string", enum: ["one", "two"], description: "Full nested schema" } }, $defs: { nested: { type: "array", items: { anyOf: [{ type: "null" }, { type: "object", additionalProperties: { type: "string" } }] } } }, additionalProperties: false } as any,
    async execute() { return { content: [{ type: "text", text: "fixture" }], details: undefined }; },
  });
  pi.on("before_agent_start", event => { event.systemPromptOptions.sections.fixture = "Synthetic before_agent_start addition\nLiteral </script> <img src=x onerror=alert(1)>"; });
  pi.on("context_with_system", event => {
    return { messages: [...event.messages, { role: "system", content: "Synthetic context addition", timestamp: 0 }] };
  });
  pi.on("before_provider_request", event => ({ ...(event.payload as object), instructions: (event.payload as any).instructions + "\nSynthetic provider-hook addition" }));
  pi.registerProvider("prompt-lint-fixture", {
    api: "prompt-lint-fixture-api", baseUrl: "http://127.0.0.1:1/never-used", apiKey: "synthetic-not-a-credential",
    models: [{ id: "fixture", name: "Prompt lint fixture (no network)", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 1000 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: "Synthetic response; no provider request was sent." }],
        api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      void (async () => {
        try {
          // Exercise the ordinary provider-hook path without serializing conversation or doing I/O.
          await options?.onPayload?.({ instructions: "Synthetic provider identity\n" + getCurrentSystemPrompt(context.messages), tools: getCurrentTools(context.messages) }, model);
          stream.push({ type: "done", reason: "stop", message }); stream.end();
        } catch {
          message.stopReason = "error"; message.errorMessage = "Synthetic fixture failed";
          stream.push({ type: "error", reason: "error", error: message }); stream.end();
        }
      })();
      return stream;
    },
  });
}
