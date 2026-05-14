# Changelog

## 0.1.0 - 2026-05-14 (planned)

### Initial fork

Forked from [discord-claude-code-bot](https://github.com/fredchu/discord-claude-code-bot) v0.8.2 — same Discord thread bridging pattern, adapted for OpenAI Codex CLI 0.128+.

### Features (planned for v0.1.0)

- **codex exec runner**: mention or slash command in allowed channels routes prompt to `codex exec` with thread-scoped session resume
- **Session resume**: `codex exec --json` parses first SessionConfigured event for session UUID; subsequent turns use `codex exec resume <uuid>`
- **Sandbox per thread**: each Discord thread maps to an isolated workdir; `codex --sandbox workspace-write` by default (override via env)
- **Role contract dispatch**: 4 slash commands (`/codex-worker`, `/codex-verifier`, `/codex-reviewer`, `/codex-synthesizer`) mirror `~/.claude/skills/codex-dispatch/` packet format
- **Quota guard**: per-user rate limit + token cap
- **Trust boundary**: bot rejects non-allowlisted guilds/channels; sensitive-path blocklist; sandbox-write scope enforced by codex itself
- **AI disclosure**: every bot response footer marks it as AI-generated

### Differences from upstream CC bot

- CLI: `codex exec` instead of `claude -p`; no `--session-id` (codex generates UUID on first run)
- Sandbox: codex has native `--sandbox` (read-only/workspace-write/danger-full-access); CC bot relied on hook-based protection
- Auth: ChatGPT subscription default (`codex login`); API key fallback via `OPENAI_API_KEY`
- No `patchSessionEntrypoint` equivalent — codex sessions are independent of bot
