# Changelog

## 0.2.0 - 2026-05-15

### Security

- **Symlink-resistant blocklist**: `isBlockedPath` now resolves the deepest existing ancestor with `fs.realpathSync` (and normalizes the configured `SENSITIVE_PATH_BLOCKLIST` the same way) before applying the prefix match, so a symlink at a non-blocked location pointing into `~/.ssh`, `~/.codex`, or any other blocked prefix cannot bypass the gate.

### Added

- **`CODEX_DISPATCH_BIN` / `CODEX_DISPATCH_PACKET_DIR`**: the `codex-dispatch` binary path and task-packet directory are now environment-driven. Defaults are `codex-dispatch` on `PATH` and `<os.tmpdir()>/discord-codex-bot-packets`, replacing the previous hard-coded developer paths.
- **Token usage in role replies**: `/codex-worker`, `/codex-verifier`, `/codex-reviewer`, and `/codex-synthesizer` now read `events.jsonl` from the codex-dispatch run directory, sum every `turn.completed.usage` payload, and append `usage: in=... (cached ...) · out=... · reasoning=...` to the Discord reply.

### Changed

- **Single key-value reply header**: collapsed the redundant `RESULT`/`POLICY VIOLATION` lines emitted alongside the backticked `policy_violation`/`exit_code` lines. The dispatch reply header now uses one consistent `key: \`value\`` form across `result`, `policy_violation`, `exit_code`, and `usage`.
- **Unified log prefix**: every runtime log line now uses `[discord-codex-bot]`. The legacy `[discord-cc-bot]` prefix carried over from the fork is gone.

### Removed

- **Per-channel daily token caps**: dropped `CODEX_TOKEN_CAP_PER_CHANNEL_DAY_INPUT` / `CODEX_TOKEN_CAP_PER_CHANNEL_DAY_OUTPUT`, the `checkChannelTokenCap` / `recordChannelTokens` paths, and their SQLite daily token buckets. Per-user hourly request rate limit (`CODEX_RATE_LIMIT_PER_USER_HOUR`) is unchanged.

## 0.1.0 - 2026-05-14

Initial open-source release of `discord-codex-bot`, forked from [discord-claude-code-bot](https://github.com/fredchu/discord-claude-code-bot) v0.8.2 and adapted for OpenAI Codex CLI 0.128+.

### Features

- **codex exec runner**: mention replies route prompt, recent thread history, and attachment file paths to `codex exec --json`.
- **Session resume**: first-run JSONL `thread.started` events provide the Codex `thread_id`; subsequent turns use `codex exec resume <uuid>`.
- **Sandbox per thread**: Codex runs with native `--sandbox workspace-write` by default and `-C <cwd>`, with optional `THREAD_WORKDIR_ROOT` per-thread directories.
- **Role contract dispatch**: `/codex-worker`, `/codex-verifier`, `/codex-reviewer`, and `/codex-synthesizer` generate codex-dispatch role packets and post artifact-backed results.
- **Quota guard**: per-user hourly request limits and per-channel daily input/output token caps are enforced from SQLite quota buckets.
- **Trust boundary**: guild/channel/DM allowlists, sensitive-path blocklist checks, thread-only execution, and Codex sandboxing gate execution.
- **AI disclosure**: first bot reply in a session identifies the output as Codex, an AI assistant by OpenAI.

### Round-by-round

- Round 1: forked the Discord thread bridge and documented the v0.1.0 target.
- Round 2: adapted the runner from `claude -p` to `codex exec --json` with session resume.
- Round 3: removed Claude-specific dead code paths.
- Round 4: added the four codex-dispatch role slash commands.
- Round 5: added the quota guard.
- Round 6: added trust-boundary hardening.
- Round 7: refreshed English docs, added Traditional Chinese docs, and finalized release notes.

Automl run_id: `20260514-130528-9616`.

### Differences from upstream CC bot

- CLI: `codex exec` instead of `claude -p`; Codex generates the session UUID on first run.
- Sandbox: Codex has native `--sandbox` (`read-only`, `workspace-write`, or `danger-full-access`); the upstream Claude Code bot relied on a hook-based protection layer.
- Auth: ChatGPT subscription auth through `codex login` by default; API key auth depends on your local Codex CLI setup.
- Session model: no `patchSessionEntrypoint` equivalent; Codex sessions are independent of the bot.
