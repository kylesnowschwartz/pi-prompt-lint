# pi-prompt-lint

`pi-prompt-lint` checks the text a [pi](https://www.npmjs.com/package/@earendil-works/pi-coding-agent) extension puts in front of the model: tool descriptions, parameter descriptions, prompt snippets and guidelines, system prompt edits, and advertised skills. pi (`@earendil-works/pi-coding-agent`) is a terminal coding agent that extensions customize. The linter lists each piece of model-visible text with the extension that contributed it, counts the characters sent with every request, and reports duplicated sentences, references to tools or skills that do not exist, and guidelines that do not name their tool.

It needs no model, network, or credentials: it loads the extensions into an offline pi session with an in-process provider and runs one local turn so `before_agent_start` handlers fire. **Linting runs the extension's code**; see [What a linted extension can change](#what-a-linted-extension-can-change).

It supports pi 1.5.2 only, because it observes pi's internal extension runner to attribute system prompt edits to the extension that made them. Node 22.19 or newer is required.

## Install

As a command, from a clone of this repository:

```sh
npm ci && npm install -g "$(npm pack --silent)"
```

`npm pack` builds the linter to JavaScript in `dist/` and writes a tarball, and `npm install -g` copies that tarball into the global prefix, so the command keeps working when the clone moves. Git ignores the `.tgz` left in the clone. Run the same command again to update. Inside the clone, `node dist/lint/cli.js …` (after `npm run build`) and `node src/lint/cli.ts …` run it without installing.

As a development dependency of an extension, for tests:

```sh
npm install --save-dev github:kylesnowschwartz/pi-prompt-lint @earendil-works/pi-coding-agent@1.5.2 @earendil-works/pi-ai@1.5.2
```

npm builds `dist/` with the package's `prepare` script while it installs from Git. pnpm stops the install until the project allows that script; add this to the project's `pnpm-workspace.yaml`:

```yaml
onlyBuiltDependencies:
  - "pi-prompt-lint"
```

The pi packages are optional peer dependencies, so the extension's own development dependencies provide them.

## Command line

```text
pi-prompt-lint [--budget <chars>] [--allow <name>]... [--json] [--isolated-home] [--agent-file <name>]... [--pi <dir>] [<extension>...]
```

| Option | Effect |
| --- | --- |
| `--budget <chars>` | Fail when an extension's always-on characters exceed this limit |
| `--allow <name>` | Accept `<name>` as a known tool or skill in reference checks (repeatable) |
| `--json` | Print the inventory, totals, and findings as JSON |
| `--isolated-home` | Run the extensions with HOME pointing at an empty temporary folder |
| `--agent-file <name>` | Also copy this top-level file of pi's agent folder into the throwaway agent folder (repeatable) |
| `--pi <dir>` | Load pi from this `@earendil-works/pi-coding-agent` package folder, or a folder whose `node_modules` holds one |
| `--version` | Print the linter version |
| `-h`, `--help` | Show help |

Each `<extension>` is an extension entry file or a package folder; a package folder loads the extensions and skills its `package.json` `pi` field lists. With no `<extension>`, it lints the current folder. It prints always-on totals per extension and channel, the active tools and loaded skills, and findings grouped by rule; `--json` prints the full result instead. Bold headings appear only on a terminal without `NO_COLOR`. `--isolated-home` runs the extensions with an empty temporary HOME (see [What a linted extension can change](#what-a-linted-extension-can-change)). `--version` prints the linter version. Exit status is 0 without error findings, 1 with error findings, and 2 for usage errors, a missing or unsupported Pi, or extensions that fail to load.

The linter loads Pi itself rather than bundling it, and supports Pi 1.5.2 only, because the observer patches that version's internals. It takes the first Pi it finds:

1. `--pi <dir>`, else the `PI_PROMPT_LINT_PI` environment variable: an `@earendil-works/pi-coding-agent` package folder, or a folder whose `node_modules` holds one.
2. `@earendil-works/pi-coding-agent` in a `node_modules` folder above the linter's own files, such as a project's development dependencies when the linter is installed there.
3. The package behind the `pi` executable on `PATH`, found by following its symlinks.

`@earendil-works/pi-ai` comes from the `node_modules` next to the Pi found. The linter imports both packages from those folders. When the Pi found is another version, the command prints that version, the supported version, and the override, and exits 2.

## Inventory

`collectInventory(entries, { cwd?, isolateHome?, agentFiles? })` takes extension entry files or package directories. A package directory also loads the skills its `package.json` `pi.skills` field lists. It returns JSON-serializable data: `extensions`, `activeTools`, `skills` (loaded skill names), `uiCalls` (extension UI methods called during the run, all no-ops offline), and `records`, one per channel entry: `{ channel, source, tool?, name?, text, characters, alwaysOn }`.

| Channel | Text | One record per |
| --- | --- | --- |
| `tool-description` | Tool `description` | tool |
| `parameter-descriptions` | Every `description` in the parameter schema, joined with newlines | tool |
| `prompt-snippet` | `promptSnippet`, the tool's line in `<tools>` | tool |
| `prompt-guideline` | One `promptGuidelines` bullet in `<rules>` | bullet |
| `system-prompt-section` | A `sections` entry set or changed by the extension's `before_agent_start` handler (`name` is the section key) | section |
| `system-prompt-guideline` | A `promptGuidelines` bullet added in `before_agent_start` | bullet |
| `system-prompt-append` | Text added to `appendSystemPrompt` in `before_agent_start` | handler |
| `system-prompt-replacement` | Lines of a returned `systemPrompt` that were not in the prompt before the handler | handler |
| `skill` | Advertised `name: description` of a skill the extension contributes (`name` is the skill name) | skill |

`alwaysOn` is true for tool channels while the tool is active by default, for every `before_agent_start` channel, and for skills that allow model invocation while `read` is active. `characters` counts UTF-16 code units.

## What a linted extension can change

The linted extensions run their real lifecycle handlers, such as `session_start`, so the run keeps them away from Pi's own state. Pi's settings, sessions, and model cache for the run live in a temporary folder. While extensions run, `PI_CODING_AGENT_DIR` and `PI_CODING_AGENT_SESSION_DIR` point at a throwaway agent folder in that temporary folder, holding a copy of the real agent folder's `settings.json` and nothing else. An extension that finds Pi's folder with `getAgentDir()` reads that copy and writes only the throwaway folder; it does not see `auth.json`, `models.json`, MCP configuration, or any other file there. `--agent-file <name>` (repeatable; `agentFiles` in the API) copies one more top-level file by name. A name with a path separator, or one that looks like a credential file (containing `auth`, `oauth`, `credential`, `secret`, `token`, `password`, or `key` as a word, or ending in `.pem`, `.p12`, or `.env`), is refused with exit status 2. The temporary folder is removed afterwards and the environment is restored. The offline model declares a context window of 0, so extensions that act on models with a positive context window skip it.

The extension UI is Pi's own no-UI context, method for method, with each call recorded: the report lists them on a `UI methods called, no-ops offline` line, and they are not findings.

An extension can still write any path it addresses directly, such as a file under HOME built from `os.homedir()`, or a hard-coded `~/.pi/agent` path, and can run commands and reach the network. `--isolated-home` (`isolateHome: true`) points HOME at an empty temporary folder too. It is off by default because extensions also read their own configuration under HOME, and that configuration changes the prompt text they contribute.

Not covered: text a handler adds only under conditions the single offline turn does not meet; `context`, `context_with_system`, and `before_provider_request` edits; text in tool results, messages, and full skill bodies; and prompt templates. Tools registered with `defaultActive: false` are inventoried with `alwaysOn: false`, and the `unknown-reference` rule treats them as unknown until active.

## Rules

`lintInventory(inventory, { budget?, allow? })` returns `{ inventory, totals, findings }`. `totals` lists always-on characters per extension and per channel. Each finding is `{ rule, severity, source, channel, tool?, message, excerpt }`.

| Rule | Severity | Finds |
| --- | --- | --- |
| `budget` | error | An extension whose always-on characters exceed `budget`. Without `budget`, the rule reports nothing and the totals carry the numbers. |
| `duplicate-sentence` | warning | A sentence of six or more words, compared ignoring case, spacing, and closing punctuation, that appears in two or more records, within one extension or across all linted extensions. |
| `unknown-reference` | warning | A backticked name that is not an active tool, a loaded skill, or in `allow`, written as a tool or skill: ``the `x` tool``, ``load the `x` skill``, ``the tool `x` ``, or ``use/call/invoke/run `x` `` when `x` is snake_case, kebab-case, or camelCase. Plain words after a verb, such as ``use `git` ``, are left alone because they are usually shell commands. |
| `guideline-names-tool` | error | A `promptGuidelines` bullet that does not contain its tool's name or says "this tool". Pi lists the bullets without a tool prefix. |

## JSON output

`--json` prints `lintInventory`'s result:

```json
{
  "inventory": { "piVersion": "1.5.2", "extensions": ["…/index.ts"], "activeTools": ["read", "bash", "my_tool"], "skills": ["my-skill"], "uiCalls": [], "records": [
    { "channel": "tool-description", "source": "…/index.ts", "tool": "my_tool", "text": "…", "characters": 120, "alwaysOn": true }
  ] },
  "totals": [{ "source": "…/index.ts", "alwaysOn": 120, "channels": { "tool-description": 120 } }],
  "findings": [{ "rule": "unknown-reference", "severity": "warning", "source": "…/index.ts", "channel": "tool-description", "tool": "my_tool", "message": "…", "excerpt": "…" }]
}
```

## Test in an extension repository

`assertPromptLint(entries, { budget?, allow?, snapshot?, update?, cwd? })` throws when there is an error finding or when the inventory differs from the snapshot file, and otherwise returns the lint result. The snapshot stores each record's text with sources relative to the snapshot file. A missing snapshot is written; `PI_PROMPT_LINT_UPDATE=1` or `update: true` rewrites it. A difference lists each changed record with `-` and `+` lines.

```ts
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { assertPromptLint } from "pi-prompt-lint";

test("prompt text", async () => {
  await assertPromptLint([fileURLToPath(new URL("..", import.meta.url))], {
    budget: 4000,
    snapshot: fileURLToPath(new URL("./prompt.snapshot.json", import.meta.url)),
  });
});
```

In a test, the linter imports `@earendil-works/pi-coding-agent` and `@earendil-works/pi-ai` the usual way, so the extension's development dependencies must provide pi 1.5.2.

## Package entry points

| Import | Built JavaScript (installed package) | TypeScript source (a local clone, imported by path) |
| --- | --- | --- |
| `pi-prompt-lint` | `dist/lint/index.js` | `src/lint/index.ts` |
| `pi-prompt-lint/observer` | `dist/observer.js` | `src/observer.ts` |

The package exports point at the built JavaScript, because Node does not strip TypeScript types inside `node_modules`. A project that imports a local clone by path uses the source files, which run with Node's type stripping.

`pi-prompt-lint` exports `collectInventory`, `schemaDescriptions`, `lintInventory`, `totals`, `formatReport`, `compareSnapshot`, `diffSnapshots`, `snapshotEntries`, `assertPromptLint`, `UPDATE_ENV`, and their types. `pi-prompt-lint/observer` exports `installObserver` and the types `ObserverEvent`, `ObserverHandle`, `ObserverOptions`, `ObserverStage`, and `PromptSnapshot`. `installObserver` patches pi 1.5.2's extension runner to report each `before_agent_start`, `context_with_system`, and `before_provider_request` handler's prompt edits; with any other pi version it installs nothing and returns `{ installed: false }`. Its optional `runner` option names the `ExtensionRunner` class to patch and defaults to the class this package imports. A pi extension that uses the observer passes the `ExtensionRunner` it imports itself: pi loads extensions through a module mapper that points pi imports at the running pi, while this package, inside `node_modules`, may import a different copy of pi whose class the running pi never uses.

## Development

```sh
npm ci                # installs and builds dist/
npm run check         # strict typecheck, ESLint, all tests
npm run build
```

## License

MIT
