# discord-codex-bot

[中文版](README.zh-TW.md)

Discord bot that bridges Discord thread conversations to OpenAI Codex CLI through `codex exec`. A compact TypeScript bot with thread-scoped Codex sessions, sandboxed workdirs, role-contract dispatch commands, quota guards, and explicit Discord trust boundaries.

Forked from [discord-claude-code-bot](https://github.com/fredchu/discord-claude-code-bot) v0.8.2 and adapted for `codex-cli` 0.128+.

For the Claude Code version, see [discord-claude-code-bot](https://github.com/fredchu/discord-claude-code-bot). The two bots can run side-by-side with different mention identities (`@claude-cc` vs `@codex`).

## Features

- **Thread sessions** - each Discord thread maps to a Codex session. First turns run `codex exec --json`; the bot parses the `thread.started` JSONL event and stores `thread_id`. Later turns use `codex exec resume <uuid>`.
- **Per-thread sandbox** - Codex runs with native `--sandbox workspace-write` by default, `-C <cwd>`, and an optional per-thread workdir root via `THREAD_WORKDIR_ROOT`.
- **Role contract dispatch** - `/codex-worker`, `/codex-verifier`, `/codex-reviewer`, and `/codex-synthesizer` create codex-dispatch packets and report run artifacts back to the Discord thread.
- **Quota guard** - per-user hourly request limits are stored in SQLite and enforced before Codex work starts.
- **Trust boundary** - guild/channel/DM allowlists gate incoming messages and slash commands, while sensitive path prefixes block unsafe `cwd`, `/cd`, and role-command workdirs.
- **AI disclosure** - the first bot reply in a session identifies the output as Codex, an AI assistant by OpenAI.
- **Thread history and attachments** - recent thread context is included in prompts, and attachments up to 10 MB are downloaded to temporary files that Codex can read.

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
- [`codex-cli`](https://github.com/openai/codex) 0.128+ installed and logged in (`codex login` with a ChatGPT account or API key)
- Discord bot token from [Discord Developer Portal](https://discord.com/developers/applications)
- A C++ toolchain for building `better-sqlite3` (Xcode CLT on macOS, `build-essential` on Linux)

### Discord bot setup

1. Create a new application in the Discord Developer Portal.
2. **Bot** -> enable **Message Content Intent**.
3. **OAuth2** -> URL Generator -> select `bot` + `applications.commands`.
4. Permissions: Send Messages, Read Message History, Attach Files, Use Slash Commands.
5. Invite the bot to your server with the generated URL.

## Slash Commands

General commands:

- `/help` - show the built-in command list.
- `/new` - clear the current Discord thread's Codex session so the next mention starts a new `codex exec` thread.
- `/model <name>` - set the Codex model override for the current Discord thread.
- `/cd <path>` - change the current Discord thread's working directory after the sensitive-path check passes.
- `/stop` - send `SIGTERM` to the running Codex or codex-dispatch process for the current Discord thread.
- `/sessions` - list active Discord thread sessions and their current model/workdir.

Role dispatch commands:

- `/codex-worker workdir:<path> objective:<text> write_scope:<csv?>` - dispatch a worker packet with an explicit write scope.
- `/codex-verifier workdir:<path> claim:<text>` - dispatch a read-only verifier packet.
- `/codex-reviewer workdir:<path> target:<text>` - dispatch a read-only reviewer packet.
- `/codex-synthesizer workdir:<path> findings:<text>` - dispatch a read-only synthesizer packet.

The role commands require a Git workdir and use `codex-dispatch` artifacts (`policy.json`, `result.md`, and worker `post-diff-stat.txt` when present) for Discord replies.

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | Bot token from Discord Developer Portal |
| `GUILD_ID` | No | Server ID for instant slash command registration; also the default guild allowlist when `ALLOWED_GUILD_IDS` is empty |
| `DEFAULT_CWD` | No | Default working directory for Codex (defaults to `process.cwd()`) |
| `CODEX_BIN` | No | Path to Codex binary (defaults to `codex`) |
| `CODEX_SANDBOX` | No | `read-only` \| `workspace-write` \| `danger-full-access` (default `workspace-write`) |
| `CODEX_MODEL` | No | Default Codex model override |
| `OPENAI_API_KEY` | No | Lets Codex use API key auth when your `codex-cli` setup supports it |
| `ALLOWED_GUILD_IDS` | No | CSV allowlist for guild messages and slash commands; falls back to `GUILD_ID` |
| `ALLOWED_CHANNEL_IDS` | No | CSV allowlist for channels inside allowed guilds; empty allows every channel in allowed guilds |
| `ALLOWED_DM_USER_IDS` | No | CSV allowlist for DMs; empty rejects all DMs |
| `SENSITIVE_PATH_BLOCKLIST` | No | CSV path-prefix blocklist for `DEFAULT_CWD`, `THREAD_WORKDIR_ROOT`, `/cd`, and role-command workdirs |
| `THREAD_WORKDIR_ROOT` | No | Optional root where new threads get `discord-<thread_id>` workdirs |
| `CODEX_RATE_LIMIT_PER_USER_HOUR` | No | Per-user request count per wall-clock hour bucket (default `30`) |
| `CODEX_DISPATCH_BIN` | No | Path to the `codex-dispatch` binary (defaults to `codex-dispatch` on `PATH`) |
| `CODEX_DISPATCH_PACKET_DIR` | No | Directory for role-dispatch task packets (defaults to `<os.tmpdir()>/discord-codex-bot-packets`) |

## Trust Boundary

The bot checks Discord origin before doing work:

- Guild messages and slash commands must come from `ALLOWED_GUILD_IDS` or the fallback `GUILD_ID`.
- `ALLOWED_CHANNEL_IDS` can narrow accepted channels inside allowed guilds.
- DMs are rejected unless the user ID is listed in `ALLOWED_DM_USER_IDS`.
- Messages in guilds only run Codex after the bot is mentioned, and Codex work only runs inside Discord threads.

Filesystem boundaries are enforced before starting Codex:

- `SENSITIVE_PATH_BLOCKLIST` blocks sensitive prefixes such as `${HOME}/.ssh`, `${HOME}/.aws`, `${HOME}/.codex`, `${HOME}/.claude`, `/etc`, and `/root` by default.
- The blocklist applies to `DEFAULT_CWD`, generated per-thread workdirs, `/cd`, mention-run `cwd`, and role-command `workdir`.
- Codex itself still receives `--sandbox <CODEX_SANDBOX>`; the default is `workspace-write`.
- v0.2.0 resolves symlinks with `fs.realpathSync` before applying the blocklist, so a symlink at a non-blocked location pointing into a blocked prefix is still rejected.

## Quota Guard

Quota state is stored in the SQLite `quota` table:

- User request limits use `CODEX_RATE_LIMIT_PER_USER_HOUR` and a wall-clock hour bucket.
- Request quota is recorded only after successful Codex or role-dispatch exits.

## Architecture

```text
Discord thread          Bot (this repo)                         Codex CLI / codex-dispatch
──────────────          ───────────────                         ─────────────────────────
@mention msg  ────►  gate guild/channel/DM
                     load thread session from SQLite
                     fetch recent thread history
                     build prompt + attachment paths
                     spawn codex exec --json ────────────────► new session
                                                    JSONL: thread.started { thread_id }
                     parse JSONL agent/tool/usage events
                     persist thread_id + last reply
              ◄────  post final reply

next mention ────►   spawn codex exec resume <uuid> --json ──► resumed session

/codex-worker ──►    write role packet
                     spawn codex-dispatch --task <packet> ───► run artifacts
              ◄────  post result.md / policy / diff stat
```

Single-file runtime (`src/index.ts`) with SQLite-backed thread and quota tables (`threads.db`, WAL mode). A one-time migration imports the older `thread-map.json` if it exists, then renames it to `thread-map.json.bak`.

## License

MIT - see `LICENSE`.
