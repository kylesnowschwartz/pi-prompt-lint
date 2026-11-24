import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Lint fixture with no findings: each guideline names its tool, references resolve, no sentence repeats. */
export default function clean(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "clean_tool", label: "Clean", description: "Returns a fixed word for lint tests.",
    promptSnippet: "Return a fixed word",
    promptGuidelines: ["Use clean_tool only in lint tests, and use `read` for files."],
    parameters: { type: "object", properties: { word: { type: "string", description: "Word to echo back" } } } as any,
    async execute() { return { content: [{ type: "text", text: "word" }], details: undefined }; },
  });
}
