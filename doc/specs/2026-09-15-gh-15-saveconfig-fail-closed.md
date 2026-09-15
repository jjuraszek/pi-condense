# saveConfig fails closed when settings.json cannot be read (#15)

**Goal:** A pi-condense settings save never replaces a `settings.json` it could not read as a JSON object, and a failed save surfaces as a `/pruner` error notification instead of an unhandled promise rejection.

Ticket: [jjuraszek/pi-condense#15](https://github.com/jjuraszek/pi-condense/issues/15). Predecessor spec: none.

## Problem

`src/config.ts` `readJsonObject` (lines 118-129) catches every error and returns `undefined` for missing, unreadable (`EACCES`, `EISDIR`, ...), truncated/invalid JSON, and non-object JSON alike. `saveConfig` (149-157) does `(await readJsonObject(path)) ?? {}` and then atomically replaces the file with `{ contextPrune: ... }`. So a transiently unreadable or half-written shared pi `settings.json` is silently overwritten, dropping every other top-level key. The doc comment above `saveConfig` (141-148) claims the write "never corrupts the file", which is false on this path.

All 12 `saveConfig(...)` calls in `src/commands.ts` (lines 825, 859, 868, 946, 974, 992, 1016, 1167, 1200, 1224, 1247, 1272) are un-awaited and uncaught; a rejection becomes an unhandled rejection while the user sees a success message. The issue says 13 sites; the count at `7c2016d` is 12.

## Decisions

| Question | Decision |
|---|---|
| In-memory state after a failed save | Stays applied for the session (no rollback). The error toast says the change did not persist. |
| Where the error handling lives | One wrapper in `src/config.ts`, `persistConfig`; call sites do not `.catch` individually. |
| Success notifications / widget refresh | Unchanged at every site; they describe the in-memory change, which did happen. |
| Startup on a broken file | `loadConfig` stays fail-soft: returns `DEFAULT_CONFIG`; deliberately no notification (a broken `settings.json` is pi-wide, not ours). |
| Test seam for a rejecting save | Dependency injection, the house style (`registerCommands` already takes injected collaborators): `saveConfig` accepts an optional `read` function, `persistConfig` an optional `save` function, `registerCommands` an optional `save` parameter. No `mock.module` - Bun's module mock is process-global and leaks across files in one `bun test src/` run. |
| pi `SettingsManager` | Not adopted. Not exposed to extensions for the `contextPrune` key; adopting it changes locking/concurrency behavior beyond this fix. |
| Separate `contextPrune.json` | Rejected; changes the documented settings location for a bug fix. |
| Last-write-wins race between concurrent saves | Out of scope (pre-existing, not #15). Only the comment's overclaim is corrected. |
| Temp-file cleanup when `rename` fails | Out of scope (pre-existing). |

## Design

### `src/config.ts`

`SettingsReadError extends Error` with fields `path: string` and `reason: string`. Message: `` `settings.json unreadable at ${path}: ${reason}` ``.

`readJsonObject(path, read = readFile)` becomes the single failure classifier (`read` has the type of `node:fs/promises` `readFile`; production callers never pass it):

| Outcome of `readFile` + `JSON.parse` | Result |
|---|---|
| `err.code === "ENOENT"` | `undefined` |
| any other `readFile` error | throws `SettingsReadError`, `reason = err.code ?? err.message` |
| `JSON.parse` throws (0-byte, truncated, garbage) | throws `SettingsReadError`, `reason = "invalid JSON"` |
| parses to `null`, array, string, number, boolean | throws `SettingsReadError`, `reason = "not a JSON object"` |
| parses to a plain object | that object |

`saveConfig(config, read = readFile)` gains only the optional `read`, forwarded to `readJsonObject`. `(await readJsonObject(path, read)) ?? {}` now yields `{}` only for ENOENT; a `SettingsReadError` propagates before `mkdir`, the temp write, and `rename`, so the existing file is byte-for-byte untouched. Write-phase errors (`mkdir`, `writeFile`, `rename`) keep rejecting as today. The doc comment is rewritten to: atomic rename means a concurrent reader never observes a partial file; a file that cannot be read as a JSON object is never replaced; concurrent saves are last-write-wins.

`loadConfig()` wraps its `readJsonObject` call in `try/catch`; on `SettingsReadError` it returns `{ ...DEFAULT_CONFIG }`, exactly as it does today for `undefined`.

New export:

```ts
type Notify = (message: string, type?: "info" | "warning" | "error") => void;

export async function persistConfig(
  notify: Notify,
  config: ContextPruneConfig,
  save: (config: ContextPruneConfig) => Promise<void> = saveConfig,
): Promise<void> {
  try {
    await save(config);
  } catch (err) {
    const reason = err instanceof SettingsReadError ? err.reason : (err as NodeJS.ErrnoException).code ?? String(err);
    notify(`Could not save settings to ${settingsPath()}: ${reason}. Change applies to this session only.`, "error");
  }
}
```

`persistConfig` never rejects. It takes the notify function rather than `ctx` so `config.ts` stays UI-agnostic and the test passes a recorder. `ContextPruneConfig` is the existing type in `src/types.ts`.

### `src/commands.ts`

`registerCommands` gains a trailing optional parameter `save: (config: ContextPruneConfig) => Promise<void> = saveConfig`. Each of the 12 `saveConfig(...)` statements becomes `void persistConfig((m, t) => ctx.ui.notify(m, t), <existing argument>, save)` - the existing argument is `currentConfig.value` at 11 sites and `newConfig` at the overlay `onChange` (line 825). The arrow keeps `notify` called as a method, per its declared `ExtensionUIContext` contract, instead of passing it unbound. The `saveConfig` import stays (it is the default for `save`); `persistConfig` is added. The synchronous overlay `onChange` uses the same form; because `persistConfig` never rejects, `void` is safe there. Nothing else at any site changes. Gate: `grep -cE "^\s*(void )?saveConfig\(" src/commands.ts` prints `0`.

### Data flow, corrupt file

`/pruner off` -> `currentConfig.value = { ...enabled: false }` -> `void persistConfig(...)` starts -> success toast `Context pruning disabled.` shown synchronously, handler returns -> (async) `readJsonObject` throws `invalid JSON` -> `saveConfig` rejects -> `persistConfig` catches -> toast `Could not save settings to /.../settings.json: invalid JSON. Change applies to this session only.` (`"error"`) -> `settings.json` unchanged -> next session `loadConfig` returns defaults.

The success toast always precedes the error toast, and the error toast lands after the handler has returned. Tests that drive a command must wait for the error notification rather than assert right after `await run(...)`.

## Edge cases

- ENOENT with a missing parent directory: `mkdir({ recursive: true })` already runs before the write; file is created containing only `contextPrune`.
- Valid file with other top-level keys: object spread preserves them (key-level, not byte-level; formatting is rewritten - the issue requires unchanged keys here).
- Unreadable regular file (`EACCES` or any non-ENOENT `readFile` error): `reason = err.code`, nothing written. Tests simulate this by injecting a `read` that rejects with `code: "EACCES"` against a real seeded file, so the case does not depend on file modes and cannot pass trivially when CI runs as root.
- Rapid overlay `onChange` calls: each save re-reads then renames; last write wins, as today.

## Testing

`bun test src/` is the gate. Real fs in `mkdtemp` dirs via the existing `PI_CODING_AGENT_DIR` setup in `src/config.test.ts:1-35`; no `mock.module`. Every case that writes a bad `settings.json` restores/removes it in `afterEach` so the shared path is clean for the next case.

`src/config.test.ts`, new cases:

| Case | Assertion |
|---|---|
| no `settings.json` | `saveConfig` resolves; file parses to exactly `{ contextPrune: {...} }` |
| `{"foo":1,"contextPrune":{"enabled":true}}` | after save, `foo === 1`, `contextPrune` replaced |
| 0-byte file; `{"foo":`; `[]`; `null`; `"str"`; `42` (each) | `saveConfig` rejects with `SettingsReadError`; `readFileSync` bytes identical before/after; `loadConfig` resolves to `DEFAULT_CONFIG` |
| seeded `{"foo":1}` + injected `read` rejecting with `code: "EACCES"` | `saveConfig(config, read)` rejects with `SettingsReadError`, `reason === "EACCES"`; bytes identical before/after |
| `persistConfig` over a truncated file | resolves; `notify` called once with `type === "error"` and a message containing `settingsPath()` |
| `persistConfig` over a missing file | resolves; `notify` not called |

`src/commands.test.ts`, one new case. Prerequisites in the file: set `process.env.PI_CODING_AGENT_DIR` to a `mkdtemp` dir at file top (precedent `src/reload-rearm.integration.test.ts:8-11`) so no command ever touches the developer's real settings; extend `setupPrunerCommand` overrides with `save?`, forward it to `registerCommands`, add a no-op `ctx.ui.setStatus` (`/pruner off` calls it), and return `currentConfig` from the harness. The test injects `save: () => Promise.reject(Object.assign(new Error("EACCES"), { code: "EACCES" }))`, registers a `process.on("unhandledRejection")` recorder (removed in `finally`), runs `/pruner off`, then waits for a notification with `type === "error"` (poll `notifications` with a short timer; a microtask-only wait can miss both the toast and an unhandled rejection) and one further `setImmediate` turn. Asserts: the error notification message contains `settingsPath()`; `Context pruning disabled.` was also recorded, before the error; `currentConfig.value.enabled === false`; the recorder saw nothing. The real `persistConfig` runs here - only `saveConfig` below it is replaced - so the notification comes from production catch code.

Coverage across the 12 sites is by the grep gate above, not 12 tests.

## Documentation impact
- Feature / user-facing docs introduced: none
- Materially amended existing docs: `CHANGELOG.md` - `## [Unreleased]` / `### Fixed` entry for #15; `README.md` settings section (line 163 area) - one sentence: an unreadable or malformed `settings.json` is never overwritten; the change applies to the session and an error names the file
- Derived / memory docs invalidated: none

Materiality bar: `reference/documentation-impact.md` (brainstorming skill).

## Acceptance criteria (from #15, adjusted)

- [ ] Absent `settings.json`: save creates it containing only `contextPrune`.
- [ ] Valid `settings.json` with other top-level keys: those keys unchanged after save.
- [ ] Present but not a JSON object (0-byte, truncated, `[]`, `null`, string, number): file byte-identical, `saveConfig` rejects.
- [ ] Present but unreadable (`EACCES` simulated by an injected rejecting `read` against a real seeded file, deterministic under root): file byte-identical, `saveConfig` rejects.
- [ ] On rejection the invoking `/pruner` command calls `ctx.ui.notify(<message containing settingsPath()>, "error")`.
- [ ] On rejection the command completes with no `unhandledRejection`; command-layer test injects a rejecting `saveConfig` below the real `persistConfig`.
- [ ] `loadConfig` on unparseable or 0-byte file returns defaults (pinned by test).
- [ ] `saveConfig` doc comment no longer claims the write cannot corrupt the file when the read failed.
- [ ] `grep -cE "^\s*(void )?saveConfig\(" src/commands.ts` prints `0`.
