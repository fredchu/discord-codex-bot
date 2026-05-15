# discord-codex-bot

[English version](README.md)

Discord bot，將 Discord thread 對話橋接到 OpenAI Codex CLI 的 `codex exec`。一個精簡的 TypeScript bot，提供 thread 範圍的 Codex session、sandbox workdir、role-contract dispatch 指令、quota guard，以及明確的 Discord trust boundary。

本專案 fork 自 [discord-claude-code-bot](https://github.com/fredchu/discord-claude-code-bot) v0.8.2，並改為支援 `codex-cli` 0.128+。

Claude Code 版本請見 [discord-claude-code-bot](https://github.com/fredchu/discord-claude-code-bot)。兩個 bot 可以用不同 mention 身分並行運作（`@claude-cc` vs `@codex`）。

## 功能

- **Thread sessions** - 每個 Discord thread 對應一個 Codex session。第一次執行使用 `codex exec --json`；bot 會解析 `thread.started` JSONL event 並保存 `thread_id`。後續回合使用 `codex exec resume <uuid>`。
- **Per-thread sandbox** - Codex 預設使用 native `--sandbox workspace-write`、`-C <cwd>`，也可以透過 `THREAD_WORKDIR_ROOT` 建立每個 thread 專屬 workdir。
- **Role contract dispatch** - `/codex-worker`、`/codex-verifier`、`/codex-reviewer`、`/codex-synthesizer` 會建立 codex-dispatch packet，並把 run artifact 回報到 Discord thread。
- **Quota guard** - 每使用者每小時 request limit 存於 SQLite，並在 Codex 工作開始前檢查。
- **Trust boundary** - guild/channel/DM allowlist 會 gate incoming messages 與 slash commands；sensitive path prefix 會阻擋不安全的 `cwd`、`/cd` 與 role-command workdir。
- **AI disclosure** - 每個 session 的第一則 bot 回覆會標明輸出來自 Codex，也就是 OpenAI 的 AI assistant。
- **Thread history and attachments** - prompt 會包含最近的 thread context；10 MB 以內的 attachment 會下載成暫存檔，讓 Codex 可以讀取。

## 快速開始

```bash
git clone https://github.com/fredchu/discord-codex-bot.git
cd discord-codex-bot
cp .env.example .env   # fill in DISCORD_TOKEN, GUILD_ID, DEFAULT_CWD
npm install
npm start
```

### 前置需求

- Node.js 22+
- 已安裝並登入的 [`codex-cli`](https://github.com/openai/codex) 0.128+（使用 ChatGPT account 或 API key 執行 `codex login`）
- 來自 [Discord Developer Portal](https://discord.com/developers/applications) 的 Discord bot token
- 可編譯 `better-sqlite3` 的 C++ toolchain（macOS 使用 Xcode CLT，Linux 使用 `build-essential`）

### Discord bot setup

1. 在 Discord Developer Portal 建立新的 application。
2. **Bot** -> 啟用 **Message Content Intent**。
3. **OAuth2** -> URL Generator -> 選擇 `bot` + `applications.commands`。
4. 權限：Send Messages、Read Message History、Attach Files、Use Slash Commands。
5. 使用產生的 URL 邀請 bot 到你的 server。

## Slash Commands

一般指令：

- `/help` - 顯示內建指令清單。
- `/new` - 清除目前 Discord thread 的 Codex session，讓下一次 mention 重新開始新的 `codex exec` thread。
- `/model <name>` - 為目前 Discord thread 設定 Codex model override。
- `/cd <path>` - 通過 sensitive-path check 後，切換目前 Discord thread 的 working directory。
- `/stop` - 對目前 Discord thread 正在執行的 Codex 或 codex-dispatch process 發送 `SIGTERM`。
- `/sessions` - 列出 active Discord thread sessions，以及目前的 model/workdir。

Role dispatch 指令：

- `/codex-worker workdir:<path> objective:<text> write_scope:<csv?>` - dispatch worker packet，並要求明確 write scope。
- `/codex-verifier workdir:<path> claim:<text>` - dispatch read-only verifier packet。
- `/codex-reviewer workdir:<path> target:<text>` - dispatch read-only reviewer packet。
- `/codex-synthesizer workdir:<path> findings:<text>` - dispatch read-only synthesizer packet。

Role commands 需要 Git workdir，並使用 `codex-dispatch` artifact（`policy.json`、`result.md`，以及 worker 有產生時的 `post-diff-stat.txt`）產生 Discord 回覆。

## 環境變數

| Variable | Required | Description |
|----------|----------|-------------|
| `DISCORD_TOKEN` | Yes | 來自 Discord Developer Portal 的 bot token |
| `GUILD_ID` | No | 用於即時註冊 slash command 的 server ID；當 `ALLOWED_GUILD_IDS` 為空時，也會作為預設 guild allowlist |
| `DEFAULT_CWD` | No | Codex 預設 working directory（預設為 `process.cwd()`） |
| `CODEX_BIN` | No | Codex binary path（預設為 `codex`） |
| `CODEX_SANDBOX` | No | `read-only` \| `workspace-write` \| `danger-full-access`（預設 `workspace-write`） |
| `CODEX_MODEL` | No | 預設 Codex model override |
| `OPENAI_API_KEY` | No | 當你的 `codex-cli` setup 支援時，讓 Codex 使用 API key auth |
| `ALLOWED_GUILD_IDS` | No | Guild messages 與 slash commands 的 CSV allowlist；未設定時 fallback 到 `GUILD_ID` |
| `ALLOWED_CHANNEL_IDS` | No | Allowed guilds 內 channels 的 CSV allowlist；空值表示 allowed guilds 裡所有 channels 皆可用 |
| `ALLOWED_DM_USER_IDS` | No | DM 的 CSV allowlist；空值表示拒絕所有 DMs |
| `SENSITIVE_PATH_BLOCKLIST` | No | 套用於 `DEFAULT_CWD`、`THREAD_WORKDIR_ROOT`、`/cd` 與 role-command workdirs 的 CSV path-prefix blocklist |
| `THREAD_WORKDIR_ROOT` | No | Optional root；新的 threads 會取得 `discord-<thread_id>` workdirs |
| `CODEX_RATE_LIMIT_PER_USER_HOUR` | No | 每使用者在 wall-clock hour bucket 內的 request count（預設 `30`） |
| `CODEX_DISPATCH_BIN` | No | `codex-dispatch` binary path（預設為 `PATH` 上的 `codex-dispatch`） |
| `CODEX_DISPATCH_PACKET_DIR` | No | Role-dispatch task packet 目錄（預設為 `<os.tmpdir()>/discord-codex-bot-packets`） |

## Trust Boundary

Bot 在開始工作前會檢查 Discord 來源：

- Guild messages 與 slash commands 必須來自 `ALLOWED_GUILD_IDS`，或 fallback 的 `GUILD_ID`。
- `ALLOWED_CHANNEL_IDS` 可以進一步限制 allowed guilds 裡可使用的 channels。
- DM 預設拒絕，除非 user ID 列在 `ALLOWED_DM_USER_IDS`。
- Guild 裡的 message 只有在 mention bot 時才會執行 Codex，而且 Codex work 只會在 Discord thread 裡執行。

Filesystem boundary 會在啟動 Codex 前檢查：

- `SENSITIVE_PATH_BLOCKLIST` 預設阻擋 `${HOME}/.ssh`、`${HOME}/.aws`、`${HOME}/.codex`、`${HOME}/.claude`、`/etc`、`/root` 等 sensitive prefix。
- Blocklist 會套用到 `DEFAULT_CWD`、產生的 per-thread workdir、`/cd`、mention-run `cwd`，以及 role-command `workdir`。
- Codex 本身仍會收到 `--sandbox <CODEX_SANDBOX>`；預設為 `workspace-write`。
- v0.2.0 起，blocklist 比對前會先用 `fs.realpathSync` 解 symlink，避免攻擊者用 symlink 把不在 blocklist 的路徑指向 blocked prefix 繞過閘門。

## Quota Guard

Quota state 存在 SQLite 的 `quota` table：

- User request limits 使用 `CODEX_RATE_LIMIT_PER_USER_HOUR` 與 wall-clock hour bucket。
- Request quota 只會在 Codex 或 role-dispatch 成功退出後記錄。

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

Runtime 採單檔架構（`src/index.ts`），並以 SQLite-backed thread 與 quota tables（`threads.db`，WAL mode）保存狀態。如果舊版 `thread-map.json` 存在，第一次啟動會匯入並改名為 `thread-map.json.bak`。

## License

MIT - see `LICENSE`.
