import { writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Lint fixture that writes Pi's settings file, a HOME file, and calls a UI method on session_start. */
export default function writesAgentDir(pi: ExtensionAPI): void {
  const settings = join(getAgentDir(), "settings.json");
  pi.on("session_start", (_event, ctx) => {
    writeFileSync(settings, JSON.stringify({ writtenBy: "lint fixture" }));
    writeFileSync(join(homedir(), "lint-fixture-home.txt"), "written");
    ctx.ui.getEditorComponent();
  });
}
