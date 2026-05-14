# discord-codex-bot

Discord bot that bridges Discord threads to OpenAI Codex CLI (`codex exec`). Single file, ~1200 lines of TypeScript (forked from [discord-claude-code-bot](https://github.com/fredchu/discord-claude-code-bot) v0.8.2, then adapted for `codex-cli` 0.128+).

**Status**: v0.1.0 in development — see `CHANGELOG.md` for planned features.

For the Claude Code version, see [discord-claude-code-bot](https://github.com/fredchu/discord-claude-code-bot). The two bots can run side-by-side with different mention identities (`@claude-cc` vs `@codex`).

## Planned features (v0.1.0)

- **Thread sessions** — each Discord thread maps to a codex session via `codex exec --json` (session UUID parsed from first event); subsequent turns use `codex exec resume <uuid>`
- **Per-thread sandbox** — codex's native `--sandbox workspace-write` per thread workdir; no hook-based protection layer needed
- **Role contract dispatch** — `/codex-worker`, `/codex-verifier`, `/codex-reviewer`, `/codex-synthesizer` slash commands construct packets per `~/.claude/skills/codex-dispatch/`
- **Quota guard** — per-user rate limit + token cap (ChatGPT subscription default; `OPENAI_API_KEY` switches to API key path)
- **Trust boundary** — guild/channel allowlist, sensitive-path blocklist, sandbox-write scope enforced by codex
- **AI disclosure** — first reply per session marks output as AI-generated

## Quickstart

```bash
git clone https://github.com/fredchu/discord-codex-bot.git
cd discord-codex-bot
cp .env.example .env   # fill in DISCORD_TOKEN, GUILD_ID, DEFAULT_CWD
npm install
npm start
```

### Prerequisites

- Node.js 22+
- [`codex-cli`](https://github.com/openai/codex) 0.128+ installed and logged in (`codex login` — ChatGPT account or API key)
- Discord bot token from [Discord Developer Portal](https://discord.com/developers/applications)
- A C++ toolchain for building `better-sqlite3` (Xcode CLT on macOS, `build-essential` on Linux)

### Discord bot setup

1. Create a new application in the Discord Developer Portal
2. **Bot** → enable **Message Content Intent**
3. **OAuth2** → URL Generator → select `bot` + `applications.commands`
4. Permissions: Send Messages, Read Message History, Attach Files, Use Slash Commands
5. Invite the bot to your server with the generated URL

## Environment variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Bot token from Discord Developer Portal |
| `GUILD_ID` | No | Server ID for instant slash command registration |
| `DEFAULT_CWD` | No | Default working directory for codex (defaults to `process.cwd()`) |
| `CODEX_BIN` | No | Path to codex binary (defaults to `codex`) |
| `CODEX_SANDBOX` | No | `read-only` \| `workspace-write` \| `danger-full-access` (default `workspace-write`) |
| `CODEX_MODEL` | No | Override codex model |
| `OPENAI_API_KEY` | No | Switch from ChatGPT subscription auth to API key |

## Architecture (planned)

```
Discord thread          Bot (this repo)             Codex CLI
──────────────          ───────────────             ─────────
@mention msg  ────►  fetch thread history
                     build prompt
                     spawn codex exec --json ─────► new session (UUID)
                                                    or resume <uuid>
              ◄────  parse JSONL events
                     extract session UUID
                     persist to threads.db
reply / .txt         post to thread     ◄────────  output-last-message
```

Single-file architecture (`src/index.ts`). SQLite-backed thread map (`threads.db`, WAL mode) — crash-safe Discord thread ID → codex session UUID.

## License

MIT — see `LICENSE`.

## 中文版

詳見 `README.zh-TW.md`（v0.1.0 ship 時補上）。
