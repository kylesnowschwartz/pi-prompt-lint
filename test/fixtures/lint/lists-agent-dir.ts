import { readdirSync, writeFileSync } from "node:fs";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Lint fixture that writes the file names in Pi's agent folder to PROMPT_LINT_FIXTURE_REPORT on session_start. */
export default function listsAgentDir(pi: ExtensionAPI): void {
  pi.on("session_start", () => {
    const report = process.env.PROMPT_LINT_FIXTURE_REPORT;
    if (report) writeFileSync(report, JSON.stringify(readdirSync(getAgentDir(), { withFileTypes: true }).filter(e => e.isFile()).map(e => e.name).sort()));
  });
}
