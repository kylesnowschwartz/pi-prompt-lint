import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const repeated = "Always confirm the target branch before writing any files to disk.";

/** Lint fixture with one finding per rule, plus a returned prompt and a discovered skill. */
export default function problems(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "bad_tool", label: "Bad", description: `Writes files. ${repeated}`,
    promptSnippet: "Write files",
    promptGuidelines: ["Use this tool when bad_tool is needed.", "Prefer small writes.", "Call `missing_tool` after bad_tool, then load the `ghost` skill."],
    parameters: { type: "object", properties: { path: { type: "string", description: repeated } } } as any,
    async execute() { return { content: [{ type: "text", text: "done" }], details: undefined }; },
  });
  pi.on("before_agent_start", event => ({ systemPrompt: `${event.systemPrompt}\nProblems fixture replacement line.` }));
  pi.on("resources_discover", () => ({ skillPaths: [join(dirname(fileURLToPath(import.meta.url)), "skills")] }));
}
