import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import Database from "better-sqlite3";
import {
  Client, GatewayIntentBits, Events,
  REST, Routes, SlashCommandBuilder,
  type Message, type Collection, type Snowflake,
} from "discord.js";

// --- ThreadMap (SQLite-backed) ---

type ThreadEntry = {
  sessionId: string;
  cwd: string;
  model: string;
  createdAt: number;
  started: boolean;
  lastBotMessageId?: string;
};

type ThreadMap = Record<string, ThreadEntry>;

const DB_PATH = path.join(import.meta.dirname, "..", "threads.db");
const JSON_PATH = path.join(import.meta.dirname, "..", "thread-map.json");

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");

db.exec(`CREATE TABLE IF NOT EXISTS threads (
  threadId TEXT PRIMARY KEY,
  sessionId TEXT NOT NULL,
  cwd TEXT NOT NULL,
  model TEXT NOT NULL,
  createdAt INTEGER NOT NULL,
  started INTEGER NOT NULL DEFAULT 0,
  lastBotMessageId TEXT
)`);

db.exec(`CREATE TABLE IF NOT EXISTS quota (
  scope TEXT NOT NULL,
  scope_id TEXT NOT NULL,
  bucket_key TEXT NOT NULL,
  bucket_start INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (scope, scope_id, bucket_key, bucket_start)
)`);

// One-time migration from JSON → SQLite
if (fs.existsSync(JSON_PATH)) {
  try {
    const old: ThreadMap = JSON.parse(fs.readFileSync(JSON_PATH, "utf8"));
    const insert = db.prepare(
      `INSERT OR IGNORE INTO threads (threadId, sessionId, cwd, model, createdAt, started, lastBotMessageId)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const migrate = db.transaction(() => {
      for (const [tid, e] of Object.entries(old)) {
        insert.run(tid, e.sessionId, e.cwd, e.model, e.createdAt, e.started ? 1 : 0, e.lastBotMessageId ?? null);
      }
    });
    migrate();
    fs.renameSync(JSON_PATH, JSON_PATH + ".bak");
    console.log(`[discord-cc-bot] migrated ${Object.keys(old).length} threads from JSON → SQLite`);
  } catch (err) {
    console.error("[discord-cc-bot] JSON migration failed:", err);
  }
}

// Prepared statements
const stmtGet = db.prepare("SELECT * FROM threads WHERE threadId = ?");
const stmtUpsert = db.prepare(
  `INSERT OR REPLACE INTO threads (threadId, sessionId, cwd, model, createdAt, started, lastBotMessageId)
   VALUES (@threadId, @sessionId, @cwd, @model, @createdAt, @started, @lastBotMessageId)`,
);
const stmtAll = db.prepare("SELECT * FROM threads");
const stmtGetQuota = db.prepare(
  `SELECT count FROM quota
   WHERE scope = ? AND scope_id = ? AND bucket_key = ? AND bucket_start = ?`,
);
const stmtAddQuota = db.prepare(
  `INSERT INTO quota (scope, scope_id, bucket_key, bucket_start, count)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT(scope, scope_id, bucket_key, bucket_start)
   DO UPDATE SET count = count + excluded.count`,
);

function rowToEntry(row: any): ThreadEntry {
  return {
    sessionId: row.sessionId,
    cwd: row.cwd,
    model: row.model,
    createdAt: row.createdAt,
    started: !!row.started,
    lastBotMessageId: row.lastBotMessageId ?? undefined,
  };
}

function loadMap(): ThreadMap {
  const map: ThreadMap = {};
  for (const row of stmtAll.all() as any[]) {
    map[row.threadId] = rowToEntry(row);
  }
  return map;
}

function saveEntry(threadId: string, entry: ThreadEntry): void {
  stmtUpsert.run({
    threadId,
    sessionId: entry.sessionId,
    cwd: entry.cwd,
    model: entry.model,
    createdAt: entry.createdAt,
    started: entry.started ? 1 : 0,
    lastBotMessageId: entry.lastBotMessageId ?? null,
  });
}

function getOrCreate(map: ThreadMap, threadId: string, defaultCwd: string): ThreadEntry {
  if (!map[threadId]) {
    const row = stmtGet.get(threadId) as any;
    if (row) {
      map[threadId] = rowToEntry(row);
    } else {
      map[threadId] = {
        sessionId: "", // codex assigns thread_id on first run; populated from JSONL thread.started event
        cwd: defaultCwd,
        model: "",
        createdAt: Date.now(),
        started: false,
      };
      saveEntry(threadId, map[threadId]);
    }
  }
  return map[threadId];
}

// --- Thread History ---

const SYSTEM_PROMPT = [
  "You are a Discord bot running inside a thread.",
  "Multiple users may be talking in the same thread.",
  "When thread history is provided, use it as context to understand the conversation so far.",
  "Reply naturally as a participant in the group conversation.",
  "IMPORTANT: Do NOT output any session handoff summaries, session recaps, bullet-point preambles, or any meta-commentary about previous sessions at the start of your reply.",
  "Respond directly and immediately to the user's message.",
  "",
  "FORMATTING: Discord does NOT render markdown tables. Never use markdown table syntax (| col | col |).",
  "When comparing items, use bold label + slash-separated attributes on one line per item, e.g.:",
  "**Opus** — Speed: Slow / Quality: Best / Price: $$$",
  "**Sonnet** — Speed: Fast / Quality: Good / Price: $$",
  "**Haiku** — Speed: Fastest / Quality: OK / Price: $",
].join("\n");

const HISTORY_FETCH_LIMIT = 30;

async function fetchThreadHistory(
  channel: Message["channel"],
  entry: ThreadEntry,
  botUserId: string,
  currentMessageId?: string,
): Promise<string> {
  const fetchOpts: { limit: number; after?: string } = { limit: HISTORY_FETCH_LIMIT };
  if (entry.started && entry.lastBotMessageId) {
    fetchOpts.after = entry.lastBotMessageId;
  }

  let messages: Collection<Snowflake, Message>;
  try {
    messages = await channel.messages.fetch(fetchOpts);
  } catch {
    return "";
  }

  if (messages.size === 0) return "";

  const sorted = [...messages.values()]
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
    .filter((m) => m.author.id !== botUserId && m.id !== currentMessageId);

  if (sorted.length === 0) return "";

  const lines = sorted.map((m) => {
    const name = m.member?.displayName ?? m.author.displayName ?? m.author.username;
    const text = m.content.replace(/<@!?\d+>/g, "").trim();
    return text ? `[${name}] ${text}` : null;
  }).filter(Boolean);

  if (lines.length === 0) return "";

  const label = entry.started
    ? "Messages from other users since your last reply"
    : "Recent thread history for context";

  return `[${label}]\n${lines.join("\n")}\n[End]\n\n`;
}

// --- Streaming Runner ---

const running = new Map<string, ChildProcess>();

type StreamCallbacks = {
  onText?: (fullText: string) => void;
  onToolUse?: (toolName: string) => void;
};

type RunResult = { text: string; exitCode: number };

type CodexUsage = {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
};

function readIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

const CODEX_RATE_LIMIT_PER_USER_HOUR = readIntegerEnv("CODEX_RATE_LIMIT_PER_USER_HOUR", 30);
const CODEX_TOKEN_CAP_PER_CHANNEL_DAY_INPUT = readIntegerEnv("CODEX_TOKEN_CAP_PER_CHANNEL_DAY_INPUT", 500_000);
const CODEX_TOKEN_CAP_PER_CHANNEL_DAY_OUTPUT = readIntegerEnv("CODEX_TOKEN_CAP_PER_CHANNEL_DAY_OUTPUT", 100_000);

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const REQUESTS_HOUR_BUCKET = "requests_hour";
const TOKENS_DAY_INPUT_BUCKET = "tokens_day_input";
const TOKENS_DAY_OUTPUT_BUCKET = "tokens_day_output";

function currentHourStart(now = Date.now()): number {
  return Math.floor(now / HOUR_MS) * HOUR_MS;
}

function currentDayStart(now = Date.now()): number {
  return Math.floor(now / DAY_MS) * DAY_MS;
}

function readQuotaCount(scope: string, scopeId: string, bucketKey: string, bucketStart: number): number {
  const row = stmtGetQuota.get(scope, scopeId, bucketKey, bucketStart) as { count: number } | undefined;
  return row?.count ?? 0;
}

function checkUserRateLimit(userId: string): { allowed: boolean; remaining: number; resetAt: number; } {
  const bucketStart = currentHourStart();
  const count = readQuotaCount("user", userId, REQUESTS_HOUR_BUCKET, bucketStart);
  return {
    allowed: count < CODEX_RATE_LIMIT_PER_USER_HOUR,
    remaining: Math.max(CODEX_RATE_LIMIT_PER_USER_HOUR - count, 0),
    resetAt: bucketStart + HOUR_MS,
  };
}

function checkChannelTokenCap(channelId: string): { allowed: boolean; usedInput: number; usedOutput: number; capInput: number; capOutput: number; } {
  const bucketStart = currentDayStart();
  const usedInput = readQuotaCount("channel", channelId, TOKENS_DAY_INPUT_BUCKET, bucketStart);
  const usedOutput = readQuotaCount("channel", channelId, TOKENS_DAY_OUTPUT_BUCKET, bucketStart);
  return {
    allowed: usedInput < CODEX_TOKEN_CAP_PER_CHANNEL_DAY_INPUT && usedOutput < CODEX_TOKEN_CAP_PER_CHANNEL_DAY_OUTPUT,
    usedInput,
    usedOutput,
    capInput: CODEX_TOKEN_CAP_PER_CHANNEL_DAY_INPUT,
    capOutput: CODEX_TOKEN_CAP_PER_CHANNEL_DAY_OUTPUT,
  };
}

function recordUserRequest(userId: string): void {
  stmtAddQuota.run("user", userId, REQUESTS_HOUR_BUCKET, currentHourStart(), 1);
}

function recordChannelTokens(channelId: string, usage: CodexUsage): void {
  const bucketStart = currentDayStart();
  // Store input and output token totals as separate daily rows so each cap can be checked independently.
  stmtAddQuota.run("channel", channelId, TOKENS_DAY_INPUT_BUCKET, bucketStart, usage.inputTokens);
  stmtAddQuota.run("channel", channelId, TOKENS_DAY_OUTPUT_BUCKET, bucketStart, usage.outputTokens);
}

function formatUserRateLimitHit(userId: string, limit: ReturnType<typeof checkUserRateLimit>): string {
  const used = CODEX_RATE_LIMIT_PER_USER_HOUR - limit.remaining;
  return `⚠️ Rate limit: ${userId} has used ${used}/${CODEX_RATE_LIMIT_PER_USER_HOUR} requests this hour. Try again at ${new Date(limit.resetAt).toISOString()}.`;
}

function formatChannelTokenCapHit(limit: ReturnType<typeof checkChannelTokenCap>): string {
  return `⚠️ Channel token cap reached: ${limit.usedInput}/${limit.capInput} input tokens or ${limit.usedOutput}/${limit.capOutput} output tokens used today.`;
}

function runCodexStreaming(opts: {
  threadId: string;
  sessionId: string;
  prompt: string;
  cwd: string;
  model: string;
  codexBin: string;
  sandbox: string;
  resume: boolean;
  systemPrompt?: string;
  timeoutMs?: number;
  callbacks?: StreamCallbacks;
}): Promise<RunResult & { sessionId: string; usage?: CodexUsage }> {
  return new Promise((resolve, reject) => {
    const fullPrompt = opts.systemPrompt
      ? `${opts.systemPrompt}\n\n---\n\n${opts.prompt}`
      : opts.prompt;

    const baseArgs: string[] = [
      "exec",
      ...(opts.resume && opts.sessionId ? ["resume", opts.sessionId] : []),
      "--json",
      "--dangerously-bypass-approvals-and-sandbox",
      "--sandbox", opts.sandbox,
      "-C", opts.cwd,
      "--skip-git-repo-check",
      ...(opts.model ? ["-m", opts.model] : []),
      fullPrompt,
    ];

    const child = spawn(opts.codexBin, baseArgs, {
      cwd: opts.cwd,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });

    running.set(opts.threadId, child);

    let buffer = "";
    let stderrBuf = "";
    let lastSeenText = "";
    let resultText = "";
    let capturedSessionId = opts.sessionId;
    let usage: CodexUsage | undefined;
    let settled = false;

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop()!;

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const event = JSON.parse(line);

          // First line of a new (non-resume) run carries the session UUID
          if (event.type === "thread.started" && event.thread_id) {
            capturedSessionId = event.thread_id;
            continue;
          }

          if (event.type === "item.completed" && event.item?.type === "agent_message") {
            const text: string = event.item.text || "";
            if (text) {
              resultText = text;
              if (text !== lastSeenText) {
                lastSeenText = text;
                opts.callbacks?.onText?.(text);
              }
            }
            continue;
          }

          // Tool-use hints (codex emits structured items for shell/edit/etc)
          if (event.type === "item.completed" && event.item?.type && event.item.type !== "agent_message") {
            opts.callbacks?.onToolUse?.(event.item.type);
            continue;
          }

          if (event.type === "turn.completed" && event.usage) {
            usage = {
              inputTokens: event.usage.input_tokens ?? 0,
              cachedInputTokens: event.usage.cached_input_tokens ?? 0,
              outputTokens: event.usage.output_tokens ?? 0,
              reasoningOutputTokens: event.usage.reasoning_output_tokens ?? 0,
            };
            continue;
          }
        } catch {
          // Not valid JSON, skip
        }
      }
    });

    const timeout = opts.timeoutMs ?? 5_400_000;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      running.delete(opts.threadId);
      child.kill("SIGTERM");
      const partial = resultText || lastSeenText || "";
      if (partial) {
        resolve({
          text: partial + "\n\n⚠️ *Task timed out after 90 min — partial result above.*",
          exitCode: 124,
          sessionId: capturedSessionId,
          usage,
        });
      } else {
        reject(new Error(`Timeout after ${timeout}ms with no output`));
      }
    }, timeout);

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(opts.threadId);
      reject(err);
    });

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(opts.threadId);
      const errHint = stderrBuf.trim() ? `\n\n⚠️ stderr: ${stderrBuf.trim().slice(0, 500)}` : "";
      const text = resultText || lastSeenText || `(no output)${errHint}`;
      resolve({
        text,
        exitCode: code ?? 1,
        sessionId: capturedSessionId,
        usage,
      });
    });
  });
}

// --- Streaming tool-use callback ---

function createToolUseHandler(ps: PreviewState): (toolName: string) => void {
  return (toolName) => {
    console.log(`[discord-cc-bot] tool: ${toolName}`);
    ps.toolsUsed.push(toolName);
    if (ps.msg) {
      const text = (ps.pendingText || "").slice(0, PREVIEW_MAX_LEN);
      ps.msg.edit(text + buildStatusLine(ps)).catch(() => {});
    }
  };
}

// --- Attachment handling ---

const ATTACH_TMP_DIR = path.join(import.meta.dirname, "..", "tmp-attachments");
const ATTACH_MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file

async function downloadAttachment(url: string, filepath: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  fs.mkdirSync(path.dirname(filepath), { recursive: true });
  fs.writeFileSync(filepath, buf);
}

// --- Chunked message sending ---

const DISCORD_MAX_LEN = 2000;
const CHUNK_LEN = 1900;

function splitMessage(text: string): string[] {
  if (text.length <= CHUNK_LEN) return [text];

  // Split text into atomic segments: complete code blocks + surrounding text.
  // Code blocks are never broken across chunks.
  const segments: string[] = [];
  const blockRegex = /^(`{3,})\w*\n[\s\S]*?^\1\s*$/gm;
  let lastEnd = 0;

  for (const match of text.matchAll(blockRegex)) {
    if (match.index! > lastEnd) {
      segments.push(text.slice(lastEnd, match.index!));
    }
    segments.push(match[0]);
    lastEnd = match.index! + match[0].length;
  }
  if (lastEnd < text.length) {
    segments.push(text.slice(lastEnd));
  }

  // Pack segments into chunks, splitting only at segment boundaries
  const chunks: string[] = [];
  let current = "";

  for (const seg of segments) {
    const combined = current + seg;
    if (combined.length <= CHUNK_LEN) {
      current = combined;
      continue;
    }

    // Won't fit — flush current chunk, start new one
    if (current) chunks.push(current);

    if (seg.length <= CHUNK_LEN) {
      current = seg;
    } else {
      // Oversized segment — detect if it's a code block
      const fenceMatch = seg.match(/^(`{3,})(\w*)\n/);
      if (fenceMatch) {
        // It's a code block — strip outer fences, split inner content, re-wrap each piece
        const fence = fenceMatch[1];
        const lang = fenceMatch[2];
        const header = fence + lang + "\n";
        const footer = "\n" + fence;
        const closeIdx = seg.lastIndexOf("\n" + fence);
        const body = seg.slice(header.length, closeIdx === -1 ? seg.length : closeIdx);
        const maxBody = CHUNK_LEN - header.length - footer.length;
        let rem = body;
        while (rem.length > maxBody) {
          let splitAt = rem.lastIndexOf("\n", maxBody);
          if (splitAt < maxBody / 2) splitAt = maxBody;
          chunks.push(header + rem.slice(0, splitAt) + footer);
          rem = rem.slice(splitAt + (rem[splitAt] === "\n" ? 1 : 0));
        }
        current = header + rem + footer;
      } else {
        // Plain text oversized — split at newlines
        let rem = seg;
        while (rem.length > CHUNK_LEN) {
          let splitAt = rem.lastIndexOf("\n", CHUNK_LEN);
          if (splitAt < CHUNK_LEN / 2) splitAt = CHUNK_LEN;
          chunks.push(rem.slice(0, splitAt));
          rem = rem.slice(splitAt + (rem[splitAt] === "\n" ? 1 : 0));
        }
        current = rem;
      }
    }
  }

  if (current) chunks.push(current);
  return chunks;
}

async function sendChunked(
  channel: { send: (content: string) => Promise<Message> },
  text: string,
  replyTo?: Message,
): Promise<Message> {
  const chunks = splitMessage(text);

  let firstMsg: Message | undefined;
  for (let i = 0; i < chunks.length; i++) {
    if (i === 0 && replyTo) {
      firstMsg = await replyTo.reply(chunks[i]);
    } else {
      const msg = await channel.send(chunks[i]);
      if (i === 0) firstMsg = msg;
    }
  }
  return firstMsg!;
}

// --- Streaming preview throttle ---

const STREAM_THROTTLE_MS = 1500;
const STREAM_MIN_DELTA = 40;
const PREVIEW_MAX_LEN = 1900;

type PreviewState = {
  msg: Message | null;
  lastText: string;
  lastEditTime: number;
  timer: NodeJS.Timeout | null;
  pendingText: string;
  startTime: number;
  toolsUsed: string[];
};

function createPreviewState(): PreviewState {
  return { msg: null, lastText: "", lastEditTime: 0, timer: null, pendingText: "", startTime: Date.now(), toolsUsed: [] };
}

function formatElapsed(startTime: number): string {
  const elapsed = Math.round((Date.now() - startTime) / 1000);
  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  return mins > 0 ? `${mins}m${secs}s` : `${secs}s`;
}

function buildStatusLine(ps: PreviewState): string {
  const time = formatElapsed(ps.startTime);
  const toolLine = ps.toolsUsed.length > 0
    ? `🔧 ${ps.toolsUsed.slice(-3).join(" → ")}\n` : "";
  return `\n\n${toolLine}⏳ *working... (${time})*`;
}

function flushPreview(ps: PreviewState): void {
  if (!ps.msg || !ps.pendingText) return;
  const display = ps.pendingText.slice(0, PREVIEW_MAX_LEN) + buildStatusLine(ps);
  ps.msg.edit(display).catch(() => {});
  ps.lastText = ps.pendingText;
  ps.lastEditTime = Date.now();
}

function handleStreamText(ps: PreviewState, fullText: string): void {
  ps.pendingText = fullText;

  const delta = fullText.length - ps.lastText.length;
  const elapsed = Date.now() - ps.lastEditTime;

  // Not enough new content
  if (delta < STREAM_MIN_DELTA && ps.lastEditTime > 0) {
    if (!ps.timer) {
      ps.timer = setTimeout(() => {
        ps.timer = null;
        flushPreview(ps);
      }, STREAM_THROTTLE_MS);
    }
    return;
  }

  // Too soon since last edit
  if (elapsed < STREAM_THROTTLE_MS && ps.lastEditTime > 0) {
    if (!ps.timer) {
      ps.timer = setTimeout(() => {
        ps.timer = null;
        flushPreview(ps);
      }, STREAM_THROTTLE_MS - elapsed);
    }
    return;
  }

  // Enough content & time — flush immediately
  if (ps.timer) clearTimeout(ps.timer);
  flushPreview(ps);
}

// --- Discord ---

const DISCORD_TOKEN = process.env.DISCORD_TOKEN!;
const DEFAULT_CWD = process.env.DEFAULT_CWD ?? process.cwd();
const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_SANDBOX = process.env.CODEX_SANDBOX ?? "workspace-write";
const CODEX_MODEL = process.env.CODEX_MODEL ?? "";
const GUILD_ID = process.env.GUILD_ID;
const CODEX_DISPATCH_BIN = "/Users/fredchu/.claude/skills/codex-dispatch/bin/codex-dispatch", CODEX_DISPATCH_PACKET_DIR = "/tmp/codex-bot-packets", CODEX_DISPATCH_TIMEOUT_MS = 30 * 60 * 1000;

type CodexRole = "worker" | "verifier" | "reviewer" | "synthesizer";

type DispatchCodexRoleOptions = {
  threadId: string;
  workdir: string;
  objective: string;
  writeScope?: string[];
};

type DispatchCodexRoleResult = {
  resultMd: string;
  diffStat: string;
  policyViolation: boolean;
  runDir: string;
  exitCode: number;
  stderrTail: string;
};

class DispatchCodexRoleError extends Error {
  constructor(message: string, public stderrTail = "") {
    super(message);
  }
}

const READ_ONLY_DISPATCH_NON_GOALS = ["Read-only mode: do not modify files.", "Do not make unrelated changes."];
const DISPATCH_DEFAULTS: Record<CodexRole, { nonGoals: string[]; verification: string[]; deliverable: string }> = {
  worker: {
    nonGoals: ["Do not modify files outside WRITE SCOPE.", "Do not make unrelated refactors."],
    verification: ["Run the smallest relevant checks and cite command evidence."],
    deliverable: "Implement the requested change, verify it, and summarize changed files and evidence.",
  },
  verifier: {
    nonGoals: READ_ONLY_DISPATCH_NON_GOALS,
    verification: ["Gather fresh command evidence for the claim."],
    deliverable: "Return a concise verification verdict with command evidence.",
  },
  reviewer: {
    nonGoals: READ_ONLY_DISPATCH_NON_GOALS,
    verification: ["Inspect the target and cite concrete file, line, or command evidence."],
    deliverable: "Return findings first, ordered by severity, with file/line references when possible.",
  },
  synthesizer: {
    nonGoals: READ_ONLY_DISPATCH_NON_GOALS,
    verification: ["Compare the supplied findings and preserve unresolved disagreements."],
    deliverable: "Return a concise synthesis of agreed facts, disagreements, risks, and next actions.",
  },
};

const CODEX_ROLE_COMMANDS: Record<string, CodexRole> = {
  "codex-worker": "worker",
  "codex-verifier": "verifier",
  "codex-reviewer": "reviewer",
  "codex-synthesizer": "synthesizer",
};

function ensureGitWorkdir(workdir: string): void {
  if (!fs.existsSync(workdir) || !fs.statSync(workdir).isDirectory()) {
    throw new DispatchCodexRoleError(`workdir not found: ${workdir}`);
  }
  if (!fs.existsSync(path.join(workdir, ".git"))) {
    throw new DispatchCodexRoleError(`workdir is not a git repository: ${workdir}`);
  }
}

function oneLine(value: string): string { return value.replace(/\s+/g, " ").trim(); }

function packetList(items: string[]): string { return items.length ? items.map((item) => `- ${item}`).join("\n") : "- none"; }

function writeCodexRolePacket(role: CodexRole, opts: DispatchCodexRoleOptions): string {
  fs.mkdirSync(CODEX_DISPATCH_PACKET_DIR, { recursive: true });
  const unixTs = Math.floor(Date.now() / 1000);
  const packetPath = path.join(CODEX_DISPATCH_PACKET_DIR, `${opts.threadId}-${role}-${unixTs}.md`);
  const writeScope = role === "worker" ? (opts.writeScope?.length ? opts.writeScope : ["none"]) : ["none"];
  const defaults = DISPATCH_DEFAULTS[role];
  const packet = [
    `MODE: ${role}`,
    `WORKDIR: ${opts.workdir}`,
    `OBJECTIVE: ${oneLine(opts.objective)}`,
    "WRITE SCOPE:",
    packetList(writeScope),
    "NON-GOALS:",
    packetList(defaults.nonGoals),
    "VERIFICATION:",
    packetList(defaults.verification),
    `DELIVERABLE: ${oneLine(defaults.deliverable)}`,
    "",
  ].join("\n");
  fs.writeFileSync(packetPath, packet, "utf8");
  return packetPath;
}

function stderrTail(stderr: string): string {
  return stderr.trim().slice(-500);
}

function parseRunDirFromStdout(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (const line of lines.reverse()) {
    if (line.includes("/.codex-dispatch/runs/") && fs.existsSync(line)) {
      return line;
    }
  }
  return null;
}

function newestRunDirSince(workdir: string, startedAt: number): string | null {
  const runsDir = path.join(workdir, ".codex-dispatch", "runs");
  if (!fs.existsSync(runsDir)) return null;
  const dirs = fs.readdirSync(runsDir)
    .map((name) => path.join(runsDir, name))
    .filter((dir) => fs.existsSync(dir) && fs.statSync(dir).isDirectory())
    .map((dir) => ({ dir, mtimeMs: fs.statSync(dir).mtimeMs }))
    .filter((entry) => entry.mtimeMs >= startedAt - 1000)
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  return dirs[0]?.dir ?? null;
}

function readRequiredArtifact(runDir: string, filename: string): string {
  const artifactPath = path.join(runDir, filename);
  if (!fs.existsSync(artifactPath)) {
    throw new DispatchCodexRoleError(`missing dispatch artifact: ${artifactPath}`);
  }
  return fs.readFileSync(artifactPath, "utf8");
}

function policyViolationFromJson(policyText: string): boolean {
  try {
    const policy = JSON.parse(policyText) as { policy_violation?: unknown; violation?: unknown };
    return policy.policy_violation === true || policy.violation === true;
  } catch {
    return true;
  }
}

function runDispatchProcess(threadId: string, workdir: string, packetPath: string): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn(CODEX_DISPATCH_BIN, ["--task", packetPath], {
      cwd: workdir,
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    running.set(threadId, child);

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      running.delete(threadId);
      child.kill("SIGTERM");
      reject(new DispatchCodexRoleError("codex-dispatch timed out after 30 minutes", stderrTail(stderr)));
    }, CODEX_DISPATCH_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(threadId);
      reject(new DispatchCodexRoleError(err.message, stderrTail(stderr)));
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      running.delete(threadId);
      resolve({ stdout, stderr, exitCode: code ?? 1 });
    });
  });
}

async function dispatchCodexRole(role: CodexRole, opts: DispatchCodexRoleOptions): Promise<DispatchCodexRoleResult> {
  ensureGitWorkdir(opts.workdir);
  const startedAt = Date.now();
  const packetPath = writeCodexRolePacket(role, opts);
  const { stdout, stderr, exitCode } = await runDispatchProcess(opts.threadId, opts.workdir, packetPath);
  const runDir = parseRunDirFromStdout(stdout) ?? newestRunDirSince(opts.workdir, startedAt);
  if (!runDir) {
    throw new DispatchCodexRoleError(`codex-dispatch exited ${exitCode} without a run_dir`, stderrTail(stderr));
  }

  const policyText = readRequiredArtifact(runDir, "policy.json");
  const resultMd = readRequiredArtifact(runDir, "result.md");
  const diffStat = fs.existsSync(path.join(runDir, "post-diff-stat.txt"))
    ? fs.readFileSync(path.join(runDir, "post-diff-stat.txt"), "utf8")
    : "";
  return {
    resultMd,
    diffStat,
    policyViolation: policyViolationFromJson(policyText),
    runDir,
    exitCode,
    stderrTail: stderrTail(stderr),
  };
}

function parseCsvPaths(csv: string | null): string[] { return (csv ?? "").split(",").map((item) => item.trim()).filter(Boolean); }

function roleFromCommand(commandName: string): CodexRole | null {
  return CODEX_ROLE_COMMANDS[commandName] ?? null;
}

function buildDispatchOptions(role: CodexRole, interaction: { channelId: string; options: any }): DispatchCodexRoleOptions {
  const threadId = interaction.channelId;
  const workdir = interaction.options.getString("workdir", true);
  if (role === "worker") {
    return {
      threadId,
      workdir,
      objective: interaction.options.getString("objective", true),
      writeScope: parseCsvPaths(interaction.options.getString("write_scope")),
    };
  }
  if (role === "verifier") {
    const claim = interaction.options.getString("claim", true);
    return { threadId, workdir, objective: `Verify claim: ${claim}` };
  }
  if (role === "reviewer") {
    const target = interaction.options.getString("target", true);
    return { threadId, workdir, objective: `Review target: ${target}` };
  }
  const findings = interaction.options.getString("findings", true);
  return { threadId, workdir, objective: `Synthesize findings: ${findings}` };
}

function formatDispatchResult(role: CodexRole, result: DispatchCodexRoleResult, includeDisclosure: boolean): string {
  const runId = path.basename(result.runDir);
  const lines = [
    includeDisclosure ? "*I'm Codex, an AI assistant by OpenAI.*\n" : "",
    `**codex-${role}** \`${runId}\``,
    `policy_violation: \`${result.policyViolation ? "true" : "false"}\``,
    `exit_code: \`${result.exitCode}\``,
  ];
  if (result.exitCode !== 0) {
    lines.push(`dispatch_error: \`codex-dispatch exited ${result.exitCode}\``);
    if (result.stderrTail) lines.push(`stderr_tail:\n\`\`\`\n${result.stderrTail}\n\`\`\``);
  }
  lines.push("", result.resultMd.trim() || "_result.md was empty_");
  if (role === "worker" && result.diffStat.trim()) {
    lines.push("", "post-diff-stat:", "```", result.diffStat.trim(), "```");
  }
  return lines.filter((line) => line !== "").join("\n");
}

function formatDispatchError(role: CodexRole, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  const tail = err instanceof DispatchCodexRoleError ? err.stderrTail : "";
  const lines = [`**codex-${role}** dispatch failed`, `error: ${message}`];
  if (tail) lines.push("stderr_tail:", "```", tail, "```");
  return lines.join("\n");
}

const slashCommands = [
  new SlashCommandBuilder().setName("help").setDescription("Show available commands"),
  new SlashCommandBuilder().setName("new").setDescription("Clear context — start a new conversation (thread only)"),
  new SlashCommandBuilder().setName("model").setDescription("Switch Codex model")
    .addStringOption(o => o.setName("name").setDescription("Model name (e.g. sonnet, opus, haiku)").setRequired(true)),
  new SlashCommandBuilder().setName("cd").setDescription("Switch working directory")
    .addStringOption(o => o.setName("path").setDescription("Absolute path to directory").setRequired(true)),
  new SlashCommandBuilder().setName("stop").setDescription("Kill running Codex process (thread only)"),
  new SlashCommandBuilder().setName("sessions").setDescription("List all active sessions"),
  new SlashCommandBuilder().setName("codex-worker").setDescription("Dispatch a worker role packet").addStringOption(o => o.setName("workdir").setDescription("Absolute git workdir").setRequired(true)).addStringOption(o => o.setName("objective").setDescription("Worker objective").setRequired(true)).addStringOption(o => o.setName("write_scope").setDescription("Optional CSV of repo-relative writable paths")),
  new SlashCommandBuilder().setName("codex-verifier").setDescription("Dispatch a verifier role packet").addStringOption(o => o.setName("workdir").setDescription("Absolute git workdir").setRequired(true)).addStringOption(o => o.setName("claim").setDescription("Claim to verify").setRequired(true)),
  new SlashCommandBuilder().setName("codex-reviewer").setDescription("Dispatch a reviewer role packet").addStringOption(o => o.setName("workdir").setDescription("Absolute git workdir").setRequired(true)).addStringOption(o => o.setName("target").setDescription("Git ref or path to review").setRequired(true)),
  new SlashCommandBuilder().setName("codex-synthesizer").setDescription("Dispatch a synthesizer role packet").addStringOption(o => o.setName("workdir").setDescription("Absolute git workdir").setRequired(true)).addStringOption(o => o.setName("findings").setDescription("Findings to synthesize").setRequired(true)),
];

if (!DISCORD_TOKEN) {
  console.error("Missing DISCORD_TOKEN");
  process.exit(1);
}

const threadMap = loadMap();

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

client.once(Events.ClientReady, async (c) => {
  console.log(`[discord-cc-bot] ready as ${c.user.tag}`);
  const rest = new REST().setToken(DISCORD_TOKEN);
  try {
    const route = GUILD_ID
      ? Routes.applicationGuildCommands(c.user.id, GUILD_ID)
      : Routes.applicationCommands(c.user.id);
    await rest.put(route, {
      body: slashCommands.map(cmd => cmd.toJSON()),
    });
    console.log(`[discord-cc-bot] registered ${slashCommands.length} slash commands`);
  } catch (err) {
    console.error("[discord-cc-bot] failed to register commands:", err);
  }
});

client.on(Events.InteractionCreate, async (interaction) => {
  // --- Button handler ---
  if (interaction.isButton()) {
    const id = interaction.customId;
    console.log(`[discord-cc-bot] button: ${id} by ${interaction.user.username}`);

    // Test buttons (temporary)
    if (id.startsWith("test_")) {
      const choice = id.replace("test_", "");
      console.log(`[discord-cc-bot] test button: ${choice}`);
      await interaction.update({
        content: `✅ **你選了：${choice}**\n\nBot 收到了你的選擇！按鈕互動成功。`,
        components: [],
      });
      return;
    }

    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  try {
    if (commandName === "help") {
      await interaction.reply({
        content: [
          "`/new` — clear context, start new conversation (thread only)",
          "`/model <name>` — switch model (e.g. sonnet, opus, haiku)",
          "`/cd <path>` — switch working directory",
          "`/stop` — kill running task (thread only)",
          "`/sessions` — list all sessions",
        ].join("\n"),
        ephemeral: true,
      });
      return;
    }

    if (commandName === "new") {
      if (!interaction.channel?.isThread()) {
        await interaction.reply({ content: "This command only works in threads.", ephemeral: true });
        return;
      }
      const threadId = interaction.channelId;
      const entry = getOrCreate(threadMap, threadId, DEFAULT_CWD);
      entry.sessionId = ""; // codex assigns thread_id on next run
      entry.started = false;
      saveEntry(threadId, entry);
      await interaction.reply({ content: "Context cleared. Next message starts a new conversation.", ephemeral: true });
      return;
    }

    if (commandName === "model") {
      const name = interaction.options.getString("name", true);
      if (!interaction.channel?.isThread()) {
        await interaction.reply({ content: "This command only works in threads.", ephemeral: true });
        return;
      }
      const threadId = interaction.channelId;
      const entry = getOrCreate(threadMap, threadId, DEFAULT_CWD);
      entry.model = name;
      saveEntry(threadId, entry);
      await interaction.reply({ content: `Model -> \`${name}\``, ephemeral: true });
      return;
    }

    if (commandName === "cd") {
      const dir = interaction.options.getString("path", true);
      if (!fs.existsSync(dir)) {
        await interaction.reply({ content: `Path not found: \`${dir}\``, ephemeral: true });
        return;
      }
      if (!interaction.channel?.isThread()) {
        await interaction.reply({ content: "This command only works in threads.", ephemeral: true });
        return;
      }
      const threadId = interaction.channelId;
      const entry = getOrCreate(threadMap, threadId, DEFAULT_CWD);
      entry.cwd = dir;
      saveEntry(threadId, entry);
      await interaction.reply({ content: `cwd -> \`${dir}\``, ephemeral: true });
      return;
    }

    if (commandName === "stop") {
      if (!interaction.channel?.isThread()) {
        await interaction.reply({ content: "This command only works in threads.", ephemeral: true });
        return;
      }
      const threadId = interaction.channelId;
      const entry = threadMap[threadId];
      if (entry && running.has(threadId)) {
        running.get(threadId)!.kill("SIGTERM");
        await interaction.reply({ content: "Stopped.", ephemeral: true });
      } else {
        await interaction.reply({ content: "Nothing running.", ephemeral: true });
      }
      return;
    }

    if (commandName === "sessions") {
      const lines = Object.entries(threadMap).map(
        ([tid, e]) => `<#${tid}> | ${e.model} | \`${e.cwd}\``,
      );
      await interaction.reply({
        content: lines.length ? lines.join("\n") : "No sessions.",
        ephemeral: true,
      });
      return;
    }

    const codexRole = roleFromCommand(commandName);
    if (codexRole) {
      if (!interaction.channel?.isThread()) {
        await interaction.reply({ content: "This command only works in threads.", ephemeral: true });
        return;
      }
      const threadId = interaction.channelId;
      if (running.has(threadId)) {
        await interaction.reply({ content: "Previous task still running. Use `/stop` first.", ephemeral: true });
        return;
      }
      const userLimit = checkUserRateLimit(interaction.user.id);
      if (!userLimit.allowed) {
        await interaction.reply({ content: formatUserRateLimitHit(interaction.user.id, userLimit), ephemeral: true });
        return;
      }
      const channelLimit = checkChannelTokenCap(threadId);
      if (!channelLimit.allowed) {
        await interaction.reply({ content: formatChannelTokenCapHit(channelLimit), ephemeral: true });
        return;
      }

      await interaction.deferReply({ ephemeral: true });
      const entry = getOrCreate(threadMap, threadId, DEFAULT_CWD);
      const includeDisclosure = !entry.started;
      try {
        const opts = buildDispatchOptions(codexRole, interaction);
        const result = await dispatchCodexRole(codexRole, opts);
        const responseText = formatDispatchResult(codexRole, result, includeDisclosure);
        const botReply = responseText.length <= DISCORD_MAX_LEN
          ? await interaction.channel.send(responseText)
          : await sendChunked(interaction.channel, responseText);
        if (includeDisclosure) entry.started = true;
        entry.lastBotMessageId = botReply.id;
        saveEntry(threadId, entry);
        await interaction.editReply(`codex-${codexRole} finished: \`${path.basename(result.runDir)}\``).catch(() => {});
        if (result.exitCode === 0) recordUserRequest(interaction.user.id);
      } catch (err) {
        const errorText = formatDispatchError(codexRole, err);
        await sendChunked(interaction.channel, errorText).catch(() => {});
        await interaction.editReply(`codex-${codexRole} failed: ${(err as Error).message}`).catch(() => {});
      }
      return;
    }
  } catch (err) {
    console.error("[discord-cc-bot] interaction error:", (err as Error).message);
    if (!interaction.replied) {
      await interaction.reply({ content: "An error occurred.", ephemeral: true }).catch(() => {});
    } else {
      await interaction.editReply("An error occurred.").catch(() => {});
    }
  }
});

client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;

    // Only respond in threads, and only when mentioned
    if (!message.channel.isThread()) return;
    if (!message.mentions.has(client.user!.id)) return;

    const content = message.content.replace(/<@!?\d+>/g, "").trim();
    const attachments = [...message.attachments.values()];
    if (!content && attachments.length === 0) return;

    const threadId = message.channelId;
    const entry = getOrCreate(threadMap, threadId, DEFAULT_CWD);

    if (running.has(threadId)) {
      await message.reply("Previous task still running. Use `/stop` first.");
      return;
    }
    const userLimit = checkUserRateLimit(message.author.id);
    if (!userLimit.allowed) {
      await message.reply(formatUserRateLimitHit(message.author.id, userLimit));
      return;
    }
    const channelLimit = checkChannelTokenCap(threadId);
    if (!channelLimit.allowed) {
      await message.reply(formatChannelTokenCapHit(channelLimit));
      return;
    }

    // Send initial preview message
    const previewState = createPreviewState();
    previewState.msg = await message.reply("⏳ *Thinking...*");

    // Download all attachments — let codex read them via fs once cwd is workspace-write
    const filePaths: string[] = [];
    for (const att of attachments) {
      if (att.size > ATTACH_MAX_BYTES) {
        console.log(`[discord-cc-bot] skipping oversized attachment: ${att.name} (${att.size} bytes)`);
        continue;
      }
      const ext = att.name?.split(".").pop() ?? "bin";
      const filepath = path.join(ATTACH_TMP_DIR, `${message.id}_${att.id}.${ext}`);
      try {
        await downloadAttachment(att.url, filepath);
        filePaths.push(filepath);
      } catch (err) {
        console.error(`[discord-cc-bot] attachment download failed: ${(err as Error).message}`);
      }
    }

    try {
      const history = await fetchThreadHistory(message.channel, entry, client.user!.id, message.id);
      let userMessage = content;
      if (filePaths.length === 1) {
        userMessage = `${content}\n\nThe user attached a file: ${filePaths[0]}`.trim();
      } else if (filePaths.length > 1) {
        userMessage = `${content}\n\nThe user attached files:\n${filePaths.map((p) => `- ${p}`).join("\n")}`.trim();
      }
      const prompt = history ? `${history}${userMessage}` : userMessage;

      const result = await runCodexStreaming({
        threadId,
        sessionId: entry.sessionId,
        prompt,
        cwd: entry.cwd,
        model: entry.model || CODEX_MODEL,
        codexBin: CODEX_BIN,
        sandbox: CODEX_SANDBOX,
        resume: entry.started && !!entry.sessionId,
        systemPrompt: SYSTEM_PROMPT,
        callbacks: {
          onText: (fullText) => handleStreamText(previewState, fullText),
          onToolUse: createToolUseHandler(previewState),
        },
      });

      // Cancel any pending throttle timer
      if (previewState.timer) clearTimeout(previewState.timer);

      // Persist codex-assigned session UUID after first run (or if it changed)
      if (result.sessionId && result.sessionId !== entry.sessionId) {
        entry.sessionId = result.sessionId;
      }

      const isFirstReply = !entry.started;
      if (isFirstReply) {
        entry.started = true;
      }

      const disclosure = isFirstReply ? "*I'm Codex, an AI assistant by OpenAI.*\n\n" : "";
      const responseText = `${disclosure}${result.text}`;

      // Final delivery — always delete preview and send new message
      // so Discord sends a push notification for the completed reply.
      let botReply: Message;
      try {
        await previewState.msg!.delete().catch(() => {});
        if (responseText.length <= DISCORD_MAX_LEN) {
          botReply = await message.reply(responseText);
        } else {
          botReply = await sendChunked(message.channel, responseText, message);
        }
      } catch (replyErr) {
        console.error("[discord-codex-bot] reply failed, trying fallback:", (replyErr as Error).message);
        botReply = await message.channel.send(responseText.slice(0, DISCORD_MAX_LEN));
      }

      entry.lastBotMessageId = botReply.id;
      saveEntry(threadId, entry);
      if (result.exitCode === 0) {
        recordUserRequest(message.author.id);
        if (result.usage) recordChannelTokens(threadId, result.usage);
      }
    } catch (err) {
      if (previewState.timer) clearTimeout(previewState.timer);
      if (previewState.msg) {
        await previewState.msg.edit(`Error: ${(err as Error).message}`).catch(() => {});
      } else {
        await message.reply(`Error: ${(err as Error).message}`);
      }
    } finally {
      for (const p of filePaths) fs.unlink(p, () => {});
    }
  } catch (err) {
    console.error("[discord-cc-bot] handler error:", (err as Error).message);
  }
});

function shutdown() {
  for (const child of running.values()) child.kill("SIGTERM");
  db.close();
  client.destroy();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

client.login(DISCORD_TOKEN);
