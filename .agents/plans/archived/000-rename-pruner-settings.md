# Plan: Rename command to `/pruner` + add `settings` subcommand

## Todo
- [x] 1. Create plan
- [x] 2. Update `src/commands.ts` — rename command `/context-prune` → `/pruner`, add `settings` subcommand with `SettingsList` overlay + nested model picker, update all user-facing strings
- [x] 3. Update `index.ts` — update comments and notification messages referencing `/context-prune`
- [x] 4. Update `src/summarizer.ts` — update log/error messages to say `pruner`
- [x] 5. Update `src/query-tool.ts` — update description strings to say `pruner`
- [x] 6. Update `src/types.ts` — update comment referencing `/context-prune now`
- [x] 7. Update `AGENTS.md` — reflect new command name and settings subcommand
- [x] 8. Verify no remaining user-facing `/context-prune` references (internal identifiers kept as-is for backward compat)

## Summary of changes
- **`src/commands.ts`**: Complete rewrite — renamed command to `pruner`, added `settings` subcommand with `SettingsList` overlay, added `submenu` model picker with `enableSearch`, updated help text, updated message renderer label to `[pruner]`
- **`index.ts`**: Updated comments and notification messages from `context-prune` to `pruner`
- **`src/summarizer.ts`**: Updated 4 log/notification messages from `context-prune` to `pruner`
- **`src/query-tool.ts`**: Updated 2 description strings from `context-prune-summary` to `pruner-summary`
- **`src/types.ts`**: Updated 1 comment from `/context-prune now` to `/pruner now`
- **`AGENTS.md`**: Updated full `commands.ts` section to document `/pruner` command, `settings` subcommand, and SettingsList overlay

### Backward-compatible identifiers kept as `context-prune`:
- `STATUS_WIDGET_ID = "context-prune"` (internal widget ID)
- Config path `~/.pi/agent/context-prune/settings.json` (file path)
- Custom entry type `context-prune-index` (session persistence key)
- `CUSTOM_TYPE_SUMMARY = "context-prune-summary"` (custom message type, still used as the registered renderer key)