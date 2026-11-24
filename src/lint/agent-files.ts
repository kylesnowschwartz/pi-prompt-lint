/** Agent-folder files copied into the throwaway agent folder by default. */
export const DEFAULT_AGENT_FILES = ["settings.json"];
const CREDENTIAL_NAME = /auth|credential|secret|token|password|passwd|oauth|(^|[^a-z])(api[-_]?)?keys?([^a-z]|$)|\.pem$|\.p12$|\.env/i;

/** Why `name` cannot be copied from the agent folder, or undefined when it can. */
export function agentFileProblem(name: string): string | undefined {
  if (!name || name === "." || name === ".." || /[\\/]/.test(name)) return `Agent file "${name}" must be a plain file name in the pi agent folder, without path separators.`;
  if (CREDENTIAL_NAME.test(name)) return `Agent file "${name}" looks like a credential file and is never copied.`;
  return undefined;
}
