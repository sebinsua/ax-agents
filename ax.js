#!/usr/bin/env node

// ax - CLI for interacting with AI agents (Codex, Claude) via `tmux`.
// Usage: ax --help
//
// Exit codes:
//   0 - success / ready
//   1 - error
//   2 - rate limited
//   3 - awaiting confirmation
//   4 - thinking
//   5 - iteration complete, more work to do (ax do)

import { execSync, spawnSync, spawn } from "node:child_process";
import {
  fstatSync,
  statSync,
  readFileSync,
  readdirSync,
  existsSync,
  appendFileSync,
  mkdirSync,
  writeFileSync,
  renameSync,
  realpathSync,
  watch,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { randomUUID, createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { parseArgs, styleText } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(
  readFileSync(path.join(__dirname, "package.json"), "utf-8")
);
const VERSION = packageJson.version;

/**
 * @typedef {'claude' | 'codex'} ToolName
 */

/**
 * @typedef {Object} ParsedSession
 * @property {string} tool
 * @property {string} [archangelName]
 * @property {string} [uuid]
 * @property {string} [permissionHash]
 * @property {boolean} [yolo]
 */

/**
 * @typedef {Object} ArchangelConfig
 * @property {string} name
 * @property {ToolName} tool
 * @property {string[]} watch
 * @property {number} interval
 * @property {string} prompt
 * @property {string} [path]
 */

/**
 * @typedef {Object} MailboxEntry
 * @property {string} timestamp
 * @property {string} type
 * @property {MailboxPayload} payload
 */

/**
 * @typedef {Object} MailboxPayload
 * @property {string} agent
 * @property {string} session
 * @property {string} branch
 * @property {string} commit
 * @property {string[]} files
 * @property {string} [summary]
 * @property {string} [message]
 * @property {string} [rfpId]
 * @property {string} [prompt]
 * @property {string} [archangel]
 * @property {string} [requestedBy]
 */

/**
 * @typedef {Object} AgentInterface
 * @property {string} name
 * @property {string} envVar
 * @property {string} startCommand
 * @property {string} approveKey
 * @property {string} rejectKey
 * @property {Record<string, string> | null} [reviewOptions]
 * @property {string} [safeAllowedTools]
 * @property {() => string} getDefaultSession
 * @property {(screen: string) => string | null} getState
 * @property {(screen: string) => ActionInfo | null} parseAction
 * @property {(screen: string) => ResponseInfo[]} extractResponses
 * @property {(yolo?: boolean) => string} buildStartCommand
 */

/**
 * @typedef {Object} ActionInfo
 * @property {string} tool
 * @property {string} action
 * @property {string} [file]
 * @property {string} [command]
 */

/**
 * @typedef {Object} ResponseInfo
 * @property {'assistant' | 'user' | 'thinking'} type
 * @property {string} text
 */

/**
 * @typedef {Object} FileEditContext
 * @property {string} intent
 * @property {{name: string, input?: any, id?: string}} toolCall
 * @property {number} editSequence
 * @property {string[]} subsequentErrors
 * @property {string[]} readsBefore
 */

/**
 * @typedef {Object} ParentSession
 * @property {string | null} session
 * @property {string} uuid
 */

/**
 * @typedef {{matcher: string, hooks: Array<{type: string, command: string, timeout?: number}>}} ClaudeHookEntry
 * @typedef {Object} ClaudeSettings
 * @property {{UserPromptSubmit?: ClaudeHookEntry[], PreToolUse?: ClaudeHookEntry[], Stop?: ClaudeHookEntry[], [key: string]: ClaudeHookEntry[] | undefined}} [hooks]
 */

// =============================================================================
// Terminal Stream Types - Abstraction layer for terminal I/O
// =============================================================================

/**
 * Style properties for terminal text (ANSI colors, formatting)
 * @typedef {Object} TerminalStyle
 * @property {string} [fg] - Foreground color (e.g., "red", "green", "#ff0000")
 * @property {string} [bg] - Background color
 * @property {boolean} [bold] - Bold text
 * @property {boolean} [dim] - Dimmed text
 * @property {boolean} [italic] - Italic text
 * @property {boolean} [underline] - Underlined text
 */

/**
 * A span of text with optional styling
 * @typedef {Object} TextSpan
 * @property {string} text - The text content
 * @property {TerminalStyle} [style] - Optional style properties
 */

/**
 * A line of terminal output, containing styled spans and raw text
 * @typedef {Object} TerminalLine
 * @property {TextSpan[]} spans - Styled text spans
 * @property {string} raw - Raw text content (spans joined, styles stripped)
 * @property {'text' | 'thinking' | 'tool'} [lineType] - Content type for styling
 */

/**
 * A segment of log output with type information
 * @typedef {Object} LogSegment
 * @property {'text' | 'thinking' | 'tool'} type - Content type
 * @property {string} content - The text content
 */

/**
 * Query for matching terminal lines
 * @typedef {Object} MatchQuery
 * @property {string | RegExp} pattern - Pattern to match against raw line text
 * @property {Partial<TerminalStyle>} [style] - Optional style filter (ignored if implementation doesn't support styles)
 */

/**
 * Result of a pattern match operation
 * @typedef {Object} MatchResult
 * @property {boolean} matched - Whether a match was found
 * @property {TerminalLine} [line] - The matched line (if matched)
 * @property {number} [lineIndex] - Index of the matched line (if matched)
 */

/**
 * Options for reading from a terminal stream
 * @typedef {Object} ReadOptions
 * @property {number} [max] - Maximum number of lines to return
 * @property {number} [timeoutMs] - Timeout in milliseconds
 */

/**
 * Options for waiting for a match
 * @typedef {Object} WaitOptions
 * @property {number} [timeoutMs] - Timeout in milliseconds
 */

/**
 * Interface for reading terminal output.
 * Implementations: JsonlTerminalStream (Claude logs), ScreenTerminalStream (tmux capture)
 * @typedef {Object} TerminalStream
 * @property {(opts?: ReadOptions) => Promise<TerminalLine[]>} readNext - Read new lines since last read
 * @property {(query: MatchQuery, opts?: WaitOptions) => Promise<MatchResult>} waitForMatch - Wait for a line matching the query
 */

const DEBUG = process.env.AX_DEBUG === "1";

// ANSI colour codes for debug output
const COLORS = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  cyan: "\x1b[96m", // Bright cyan
  magenta: "\x1b[95m", // Bright magenta
  yellow: "\x1b[93m", // Bright yellow
  red: "\x1b[91m", // Bright red
};

/**
 * @param {string} context
 * @param {unknown} err
 */
function debugError(context, err) {
  if (DEBUG) {
    const msg = err instanceof Error ? err.message : err;
    console.error(
      `${COLORS.bright}${COLORS.red}[error:${context}]${COLORS.reset} ${COLORS.magenta}${msg}${COLORS.reset}`
    );
  }
}

/**
 * Log debug message when AX_DEBUG=1
 * @param {string} tag - Short tag for the debug message (e.g., "poll", "tmux")
 * @param {string} message - The debug message
 */
function debug(tag, message) {
  if (DEBUG) {
    console.error(
      `${COLORS.bright}${COLORS.cyan}[${tag}]${COLORS.reset} ${COLORS.yellow}${message}${COLORS.reset}`
    );
  }
}

// =============================================================================
// Project root detection (walk up to find .ai/ directory)
// =============================================================================

function findProjectRoot(startDir = process.cwd()) {
  let dir = startDir;
  while (dir !== path.dirname(dir)) {
    if (existsSync(path.join(dir, ".ai"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }
  // Fallback to cwd if no .ai/ found (will be created on first use)
  return startDir;
}

const PROJECT_ROOT = findProjectRoot();
const AI_DIR = path.join(PROJECT_ROOT, ".ai");
const AGENTS_DIR = path.join(AI_DIR, "agents");
const HOOKS_DIR = path.join(AI_DIR, "hooks");
const RFP_DIR = path.join(AI_DIR, "rfps");
const DO_DIR = path.join(AI_DIR, "do");

/**
 * Get path to progress file for a named do task
 * @param {string} name - Task name (default: "default")
 * @returns {string}
 */
function getDoProgressPath(name = "default") {
  const dir = path.join(DO_DIR, name);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, "progress.txt");
  // Touch the file if it doesn't exist so agent can read it on first iteration
  if (!existsSync(filePath)) writeFileSync(filePath, "");
  return filePath;
}

/**
 * Build prompt for do loop with preamble and progress context
 * @param {string} userPrompt
 * @param {string} name
 * @returns {string}
 */
function buildDoPrompt(userPrompt, name) {
  const progressPath = getDoProgressPath(name);
  const progress = existsSync(progressPath)
    ? readFileSync(progressPath, "utf-8")
    : "";

  const relProgressPath = `.ai/do/${name}/progress.txt`;
  const preamble = DO_PREAMBLE.replace(/\{progressPath\}/g, relProgressPath);

  return `${preamble}

## Progress So Far
${progress || "(No progress yet)"}

## Your Task
${userPrompt}

Remember: Work on ONE thing, update ${relProgressPath}, then verify it works.
When ALL tasks are complete, output <promise>COMPLETE</promise>`;
}

// =============================================================================
// Helpers - tmux
// =============================================================================

/**
 * @param {string[]} args
 * @returns {string}
 */
function tmux(args) {
  const result = spawnSync("tmux", args, { encoding: "utf-8" });
  if (result.status !== 0) throw new Error(result.stderr || "tmux error");
  return result.stdout;
}

/**
 * @param {string} session
 * @returns {boolean}
 */
function tmuxHasSession(session) {
  try {
    tmux(["has-session", "-t", session]);
    return true;
  } catch {
    return false;
  }
}

/**
 * @param {string} session
 * @param {number} [scrollback]
 * @param {boolean} [withEscapes] - Include ANSI escape sequences (uses -e flag)
 * @returns {string}
 */
function tmuxCapture(session, scrollback = 0, withEscapes = false) {
  try {
    const args = ["capture-pane", "-t", session, "-p"];
    if (withEscapes) args.push("-e"); // Include escape sequences
    if (scrollback) args.push("-S", String(-scrollback));
    return tmux(args);
  } catch (err) {
    debugError("tmuxCapture", err);
    return "";
  }
}

/**
 * @param {string} session
 * @param {string} keys
 */
function tmuxSend(session, keys) {
  debug("tmux", `send session=${session}, keys=${keys}`);
  tmux(["send-keys", "-t", session, keys]);
}

/**
 * @param {string} session
 * @param {string} text
 */
function tmuxSendLiteral(session, text) {
  debug("tmux", `sendLiteral session=${session}, text=${text.slice(0, 50)}...`);
  tmux(["send-keys", "-t", session, "-l", text]);
}

/**
 * Paste text into a tmux session using load-buffer + paste-buffer.
 * More reliable than send-keys -l for large text.
 * Uses a named buffer to avoid races with concurrent invocations.
 * @param {string} session
 * @param {string} text
 */
function tmuxPasteLiteral(session, text) {
  debug(
    "tmux",
    `pasteLiteral session=${session}, text=${text.slice(0, 50)}...`
  );
  // Use unique buffer name per invocation to avoid races (even to same session)
  const bufferName = `ax-${process.pid}-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
  // Load text into named tmux buffer from stdin
  const loadResult = spawnSync("tmux", ["load-buffer", "-b", bufferName, "-"], {
    input: text,
    encoding: "utf-8",
  });
  if (loadResult.status !== 0) {
    debug("tmux", `load-buffer failed: ${loadResult.stderr}`);
    throw new Error(loadResult.stderr || "tmux load-buffer failed");
  }
  try {
    // Paste buffer into the session
    tmux(["paste-buffer", "-b", bufferName, "-t", session]);
    // Move cursor to end of pasted text
    tmux(["send-keys", "-t", session, "End"]);
  } finally {
    // Clean up the named buffer
    try {
      tmux(["delete-buffer", "-b", bufferName]);
    } catch (err) {
      debugError("tmuxPasteLiteral", err);
    }
  }
}

/**
 * Paste text and send Enter, waiting for multiline paste indicator if needed.
 * Claude Code shows "[Pasted text #N +M lines]" for multiline input and needs
 * time to process it before accepting Enter.
 * @param {string} session
 * @param {string} text
 */
async function tmuxSendText(session, text) {
  const parsed = parseSessionName(session);
  const isClaude = parsed?.tool === "claude";
  const newlineCount = (text.match(/\n/g) || []).length;

  tmuxPasteLiteral(session, text);

  // For multiline text in Claude, use adaptive delay based on paste size
  if (isClaude && newlineCount > 0) {
    const delay = Math.min(1500, 50 + 3 * text.length + 20 * newlineCount);
    debug(
      "sendText",
      `multiline paste (${text.length} chars, ${newlineCount} lines), waiting ${delay}ms`
    );
    await sleep(delay);
  }
  tmuxSend(session, "Enter");
}

/**
 * @param {string} session
 */
function tmuxKill(session) {
  try {
    tmux(["kill-session", "-t", session]);
  } catch (err) {
    debugError("tmuxKill", err);
  }
}

/**
 * Rename a tmux session.
 * @param {string} oldName
 * @param {string} newName
 * @returns {boolean}
 */
function tmuxRenameSession(oldName, newName) {
  try {
    tmux(["rename-session", "-t", oldName, newName]);
    debug("tmux", `renamed session: ${oldName} -> ${newName}`);
    return true;
  } catch (err) {
    debugError("tmuxRenameSession", err);
    return false;
  }
}

/**
 * @param {string} session
 * @param {string} command
 */
function tmuxNewSession(session, command) {
  debug("tmux", `newSession: ${session}, command: ${command.slice(0, 80)}...`);
  // Use spawnSync to avoid command injection via session/command
  const result = spawnSync(
    "tmux",
    ["new-session", "-d", "-s", session, command],
    {
      encoding: "utf-8",
    }
  );
  if (result.status !== 0) {
    debug("tmux", `newSession failed: ${result.stderr}`);
    throw new Error(result.stderr || "tmux new-session failed");
  }
}

/**
 * @returns {string | null}
 */
function tmuxCurrentSession() {
  if (!process.env.TMUX) return null;
  const result = spawnSync("tmux", ["display-message", "-p", "#S"], {
    encoding: "utf-8",
  });
  if (result.status !== 0) return null;
  return result.stdout.trim();
}

/**
 * @typedef {Object} SessionPermissions
 * @property {'yolo' | 'custom' | 'safe'} mode
 * @property {string | null} allowedTools
 * @property {string | null} hash
 */

const SAFE_PERMISSIONS = /** @type {SessionPermissions} */ ({
  mode: "safe",
  allowedTools: null,
  hash: null,
});

/**
 * Get permission info from a session based on its name.
 * Session name encodes permission mode: -yolo, -p{hash}, or neither (safe).
 * @param {string} session
 * @returns {SessionPermissions}
 */
function getSessionPermissions(session) {
  const parsed = parseSessionName(session);
  if (parsed?.yolo) {
    return { mode: "yolo", allowedTools: null, hash: null };
  }
  if (parsed?.permissionHash) {
    return { mode: "custom", allowedTools: null, hash: parsed.permissionHash };
  }
  return SAFE_PERMISSIONS;
}

/**
 * Check if a session was started in yolo mode.
 * @param {string} session
 * @returns {boolean}
 */
function isYoloSession(session) {
  return getSessionPermissions(session).mode === "yolo";
}

/**
 * Normalize allowed tools string for consistent hashing.
 * Splits on tool boundaries (e.g., 'Bash("...") Read') while preserving quoted content.
 * @param {string} tools
 * @returns {string}
 */
function normalizeAllowedTools(tools) {
  // Match tool patterns: ToolName or ToolName("args") or ToolName("args with spaces")
  const toolPattern = /\w+(?:\("[^"]*"\))?/g;
  const matches = tools.match(toolPattern) || [];
  return matches.sort().join(" ");
}

/**
 * Compute a short hash of the allowed tools for session naming.
 * @param {string | null | undefined} allowedTools
 * @returns {string | null}
 */
function computePermissionHash(allowedTools) {
  if (!allowedTools) return null;
  const normalized = normalizeAllowedTools(allowedTools);
  return createHash("sha256").update(normalized).digest("hex").slice(0, 8);
}

// =============================================================================
// Helpers - timing
// =============================================================================

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POLL_MS = parseInt(process.env.AX_POLL_MS || "200", 10);
const DEFAULT_TIMEOUT_MS = parseInt(process.env.AX_TIMEOUT_MS || "120000", 10);
const REVIEW_TIMEOUT_MS = parseInt(
  process.env.AX_REVIEW_TIMEOUT_MS || "900000",
  10
); // 15 minutes
const STARTUP_TIMEOUT_MS = parseInt(
  process.env.AX_STARTUP_TIMEOUT_MS || "30000",
  10
);
const ARCHANGEL_STARTUP_TIMEOUT_MS = parseInt(
  process.env.AX_ARCHANGEL_STARTUP_TIMEOUT_MS || "60000",
  10
);
const ARCHANGEL_RESPONSE_TIMEOUT_MS = parseInt(
  process.env.AX_ARCHANGEL_RESPONSE_TIMEOUT_MS || "300000",
  10
); // 5 minutes
const ARCHANGEL_HEALTH_CHECK_MS = parseInt(
  process.env.AX_ARCHANGEL_HEALTH_CHECK_MS || "30000",
  10
);
const STABLE_MS = parseInt(process.env.AX_STABLE_MS || "1000", 10);
const APPROVE_DELAY_MS = parseInt(process.env.AX_APPROVE_DELAY_MS || "100", 10);
const MAILBOX_MAX_AGE_MS = parseInt(
  process.env.AX_MAILBOX_MAX_AGE_MS || "3600000",
  10
); // 1 hour
const CLAUDE_CONFIG_DIR =
  process.env.AX_CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const CODEX_CONFIG_DIR =
  process.env.AX_CODEX_CONFIG_DIR || path.join(os.homedir(), ".codex");
const TRUNCATE_USER_LEN = 500;
const TRUNCATE_THINKING_LEN = 300;
const ARCHANGEL_GIT_CONTEXT_HOURS = 4;
const ARCHANGEL_GIT_CONTEXT_MAX_LINES = 200;
const ARCHANGEL_PARENT_CONTEXT_ENTRIES = 10;
const ARCHANGEL_PREAMBLE = `## Guidelines

- If you have nothing to report, you MUST respond with ONLY "EMPTY_RESPONSE".
- Investigate before speaking. If uncertain, read more code and trace the logic until you're confident.
- Explain WHY something is an issue, not just that it is.
- Focus on your area of expertise.
- Calibrate to the task or plan. Don't suggest refactors during a bug fix.
- Be clear. Brief is fine, but never sacrifice clarity.
- For critical issues, request for them to be added to the todo list.
- Don't repeat observations you've already made unless you have more to say or better clarity.
- Make judgment calls - don't ask questions.`;
const RFP_PREAMBLE = `## Guidelines

- Your only task is to propose a single idea in response to this RFP. This overrides any other goals or habits.
- Provide exactly one proposal.
- Make a persuasive case for why this is a strong idea.
- Think deeply before you answer; avoid first-impression responses.
- Aim for 3–4 clear paragraphs.
- Ground the idea in the actual context you were given; don’t ignore it.
- If you need context, read the existing project or conversation before proposing.
- Structure: (1) core insight/value, (2) who benefits & why now, (3) risks/tradeoffs (brief), (4) closing case.
- Focus on value: what improves, for whom, and why now.
- Do NOT review code or report bugs.
- Do NOT describe scope, implementation approach, or plan.
- You may briefly note tradeoffs, but they are not the focus.
- Prioritize clarity over brevity.
- If you have nothing to propose, respond with ONLY "EMPTY_RESPONSE".`;

// Note: DO_PREAMBLE is a template - {progressPath} gets replaced at runtime
const DO_PREAMBLE = `You are an autonomous coding agent in a loop. Each iteration:

1. Read {progressPath} to see what's done (empty means nothing done yet).
2. Choose the next task:
  - Start with trivial/mechanistic work. It banks progress, builds context, and constrains nothing.
  - Then do foundational work that makes harder problems easier and safer to approach.
  - Defer risky/architectural decisions until they resolve themselves or there's no other way.
  - If a change is hard to reverse, stop. Surface it as a decision for review.
3. Read existing code before modifying it.
4. Implement ONE small change - minimal diff.
5. Verify the change works. Run typechecking, linting and relevant tests.
6. Append to {progressPath}: task done + files changed.
7. If ALL tasks complete, output: <promise>COMPLETE</promise>.

Guidelines:
- Make minimal changes. Don't refactor surrounding code.
- DO extract a shared abstraction when you're repeating a decision — that's an invariant, not tidying.
- If stuck after 2-3 attempts, document the blocker in {progressPath} and move on.
- Update {progressPath} BEFORE outputting COMPLETE.`;

/**
 * @param {string} session
 * @param {(screen: string) => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
class TimeoutError extends Error {
  /** @param {string} [session] */
  constructor(session) {
    super("timeout");
    this.name = "TimeoutError";
    this.session = session;
  }
}

/**
 * @param {string} session
 * @param {(screen: string) => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
async function waitFor(session, predicate, timeoutMs = STARTUP_TIMEOUT_MS) {
  const start = Date.now();
  debug("waitFor", `waiting (timeout=${timeoutMs}ms)`);
  while (Date.now() - start < timeoutMs) {
    const screen = tmuxCapture(session);
    if (predicate(screen)) {
      debug("waitFor", `matched after ${Date.now() - start}ms`);
      return screen;
    }
    await sleep(POLL_MS);
  }
  debug("waitFor", `timeout after ${timeoutMs}ms`);
  throw new TimeoutError(session);
}

// =============================================================================
// Helpers - process
// =============================================================================

/**
 * @returns {{pid: number, agent: 'claude' | 'codex'} | null}
 */
function findCallerAgent() {
  let pid = process.ppid;
  while (pid > 1) {
    const result = spawnSync(
      "ps",
      ["-p", pid.toString(), "-o", "ppid=,comm="],
      {
        encoding: "utf-8",
      }
    );
    if (result.status !== 0) break;
    const parts = result.stdout.trim().split(/\s+/);
    const ppid = parseInt(parts[0], 10);
    const cmd = parts.slice(1).join(" ");
    if (cmd.includes("claude")) return { pid, agent: "claude" };
    if (cmd.includes("codex")) return { pid, agent: "codex" };
    pid = ppid;
  }
  return null;
}

/**
 * Find orphaned claude/codex processes (PPID=1, reparented to init/launchd)
 * @returns {{pid: string, command: string}[]}
 */
function findOrphanedProcesses() {
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,args="], {
    encoding: "utf-8",
  });

  if (result.status !== 0 || !result.stdout.trim()) {
    return [];
  }

  const orphans = [];
  for (const line of result.stdout.trim().split("\n")) {
    // Parse: "  PID  PPID  command args..."
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) continue;

    const [, pid, ppid, args] = match;

    // Must have PPID=1 (orphaned/reparented to init)
    if (ppid !== "1") continue;

    // Command must START with claude or codex (excludes tmux which also has PPID=1)
    const cmd = args.split(/\s+/)[0];
    if (cmd !== "claude" && cmd !== "codex") continue;

    orphans.push({ pid, command: args.slice(0, 60) });
  }

  return orphans;
}

// =============================================================================
// Helpers - stdin
// =============================================================================

/**
 * @returns {boolean}
 */
function hasStdinData() {
  try {
    const stat = fstatSync(0);
    return stat.isFIFO() || stat.isFile();
  } catch {
    return false;
  }
}

/**
 * @returns {Promise<string>}
 */
async function readStdin() {
  return new Promise((resolve) => {
    let data = "";
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data.trim()));
  });
}

/**
 * @param {string | null | undefined} value
 * @returns {Promise<string | undefined>}
 */
async function readStdinIfNeeded(value) {
  if (value && value !== "-") return value;
  if (!hasStdinData()) return undefined;
  const stdinText = await readStdin();
  return stdinText || undefined;
}

// =============================================================================
// =============================================================================
// Helpers - CLI argument parsing
// =============================================================================

/**
 * Parse CLI arguments using Node.js built-in parseArgs.
 * @param {string[]} args - Command line arguments (without node and script path)
 * @returns {{ flags: ParsedFlags, positionals: string[] }}
 *
 * @typedef {Object} ParsedFlags
 * @property {boolean} wait
 * @property {boolean} noWait
 * @property {boolean} yolo
 * @property {boolean} fresh
 * @property {boolean} reasoning
 * @property {boolean} follow
 * @property {boolean} all
 * @property {boolean} orphans
 * @property {boolean} force
 * @property {boolean} stale
 * @property {boolean} version
 * @property {boolean} help
 * @property {string} [tool]
 * @property {string} [session]
 * @property {number} [timeout]
 * @property {number} [tail]
 * @property {number} [limit]
 * @property {string} [branch]
 * @property {string} [archangels]
 * @property {string} [autoApprove]
 * @property {string} [name]
 * @property {number} [maxLoops]
 * @property {boolean} loop
 * @property {boolean} reset
 */
function parseCliArgs(args) {
  const { values, positionals } = parseArgs({
    args,
    options: {
      // Boolean flags
      wait: { type: "boolean", default: false },
      "no-wait": { type: "boolean", default: false },
      yolo: { type: "boolean", default: false },
      fresh: { type: "boolean", default: false },
      reasoning: { type: "boolean", default: false },
      follow: { type: "boolean", short: "f", default: false },
      all: { type: "boolean", default: false },
      orphans: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      stale: { type: "boolean", default: false },
      version: { type: "boolean", short: "V", default: false },
      help: { type: "boolean", short: "h", default: false },
      loop: { type: "boolean", default: false },
      reset: { type: "boolean", default: false },
      // Value flags
      tool: { type: "string" },
      "auto-approve": { type: "string" },
      session: { type: "string" },
      timeout: { type: "string" },
      tail: { type: "string" },
      limit: { type: "string" },
      branch: { type: "string" },
      archangels: { type: "string" },
      name: { type: "string" },
      "max-loops": { type: "string" },
    },
    allowPositionals: true,
    strict: false, // Don't error on unknown flags
  });

  return {
    flags: {
      wait: Boolean(values.wait),
      noWait: Boolean(values["no-wait"]),
      yolo: Boolean(values.yolo),
      fresh: Boolean(values.fresh),
      reasoning: Boolean(values.reasoning),
      follow: Boolean(values.follow),
      all: Boolean(values.all),
      orphans: Boolean(values.orphans),
      force: Boolean(values.force),
      stale: Boolean(values.stale),
      version: Boolean(values.version),
      help: Boolean(values.help),
      tool: /** @type {string | undefined} */ (values.tool),
      session: /** @type {string | undefined} */ (values.session),
      timeout:
        values.timeout !== undefined ? Number(values.timeout) : undefined,
      tail: values.tail !== undefined ? Number(values.tail) : undefined,
      limit: values.limit !== undefined ? Number(values.limit) : undefined,
      branch: /** @type {string | undefined} */ (values.branch),
      archangels: /** @type {string | undefined} */ (values.archangels),
      autoApprove: /** @type {string | undefined} */ (values["auto-approve"]),
      name: /** @type {string | undefined} */ (values.name),
      maxLoops:
        values["max-loops"] !== undefined
          ? Number(values["max-loops"])
          : undefined,
      loop: Boolean(values.loop),
      reset: Boolean(values.reset),
    },
    positionals,
  };
}

// Helpers - session tracking
// =============================================================================

// Regex pattern strings for session name parsing
const UUID_PATTERN =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PERM_HASH_PATTERN = "[0-9a-f]{8}";

/**
 * @param {string} session
 * @returns {ParsedSession | null}
 */
function parseSessionName(session) {
  const match = session.match(/^(claude|codex)-(.+)$/i);
  if (!match) return null;

  const tool = match[1].toLowerCase();
  const rest = match[2];

  // Archangel: {tool}-archangel-{name}-{uuid}
  const archangelPattern = new RegExp(
    `^archangel-(.+)-(${UUID_PATTERN})$`,
    "i"
  );
  const archangelMatch = rest.match(archangelPattern);
  if (archangelMatch) {
    return { tool, archangelName: archangelMatch[1], uuid: archangelMatch[2] };
  }

  // Partner: {tool}-partner-{uuid}[-p{hash}|-yolo]
  const partnerPattern = new RegExp(
    `^partner-(${UUID_PATTERN})(?:-p(${PERM_HASH_PATTERN})|-(yolo))?$`,
    "i"
  );
  const partnerMatch = rest.match(partnerPattern);
  if (partnerMatch) {
    const result = { tool, uuid: partnerMatch[1] };
    if (partnerMatch[2]) {
      return { ...result, permissionHash: partnerMatch[2] };
    }
    if (partnerMatch[3]) {
      return { ...result, yolo: true };
    }
    return result;
  }

  // Anything else
  return { tool };
}

/**
 * @param {string} tool
 * @param {{allowedTools?: string | null, yolo?: boolean}} [options]
 * @returns {string}
 */
function generateSessionName(tool, { allowedTools = null, yolo = false } = {}) {
  const uuid = randomUUID();
  if (yolo) {
    return `${tool}-partner-${uuid}-yolo`;
  }
  const hash = computePermissionHash(allowedTools);
  if (hash) {
    return `${tool}-partner-${uuid}-p${hash}`;
  }
  return `${tool}-partner-${uuid}`;
}

/**
 * Rebuild a session name with a new UUID, preserving other attributes.
 * @param {string} sessionName - existing session name
 * @param {string} newUuid - new UUID to use
 * @returns {string | null}
 */
function rebuildSessionName(sessionName, newUuid) {
  const parsed = parseSessionName(sessionName);
  if (!parsed || !parsed.uuid) return null;

  // Archangel sessions: {tool}-archangel-{name}-{uuid}
  if (parsed.archangelName) {
    return `${parsed.tool}-archangel-${parsed.archangelName}-${newUuid}`;
  }

  // Partner sessions: {tool}-partner-{uuid}[-p{hash}|-yolo]
  let name = `${parsed.tool}-partner-${newUuid}`;
  if (parsed.yolo) {
    name += "-yolo";
  } else if (parsed.permissionHash) {
    name += `-p${parsed.permissionHash}`;
  }
  return name;
}

/**
 * Quick hash for change detection (not cryptographic).
 * @param {string | null | undefined} str
 * @returns {string | null}
 */
function quickHash(str) {
  if (!str) return null;
  return createHash("md5").update(str).digest("hex").slice(0, 8);
}

/**
 * @param {string} cwd
 * @returns {string}
 */
function getClaudeProjectPath(cwd) {
  // Claude encodes project paths by replacing / with -
  // e.g., /Users/sebinsua/dev/gruf -> -Users-sebinsua-dev-gruf
  return cwd.replace(/\//g, "-");
}

/**
 * @param {string} sessionName
 * @returns {string | null}
 */
function getTmuxSessionCwd(sessionName) {
  try {
    const result = spawnSync(
      "tmux",
      ["display-message", "-t", sessionName, "-p", "#{pane_current_path}"],
      {
        encoding: "utf-8",
      }
    );
    if (result.status === 0) return result.stdout.trim();
  } catch (err) {
    debugError("getTmuxSessionCwd", err);
  }
  return null;
}

/**
 * @param {string} sessionId
 * @param {string | null} sessionName
 * @returns {string | null}
 */
function findClaudeLogPath(sessionId, sessionName) {
  // Get cwd from tmux session, fall back to process.cwd()
  const cwd = (sessionName && getTmuxSessionCwd(sessionName)) || process.cwd();
  const projectPath = getClaudeProjectPath(cwd);
  const claudeProjectDir = path.join(
    CLAUDE_CONFIG_DIR,
    "projects",
    projectPath
  );
  debug(
    "log",
    `findClaudeLogPath: sessionId=${sessionId}, projectDir=${claudeProjectDir}`
  );

  // Check sessions-index.json first
  const indexPath = path.join(claudeProjectDir, "sessions-index.json");
  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(readFileSync(indexPath, "utf-8"));
      const entry = index.entries?.find(
        /** @param {{sessionId: string, fullPath?: string}} e */ (e) =>
          e.sessionId === sessionId
      );
      if (entry?.fullPath) {
        debug("log", `findClaudeLogPath: found via index -> ${entry.fullPath}`);
        return entry.fullPath;
      }
    } catch (err) {
      debugError("findClaudeLogPath", err);
    }
  }

  // Fallback: direct path
  const directPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);
  if (existsSync(directPath)) {
    debug("log", `findClaudeLogPath: found via direct path -> ${directPath}`);
    return directPath;
  }

  // Fallback: most recently modified session from index (handles /new creating new sessions)
  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(readFileSync(indexPath, "utf-8"));
      if (index.entries?.length) {
        const sorted = [...index.entries].sort((a, b) => {
          const aTime = a.modified ? new Date(a.modified).getTime() : 0;
          const bTime = b.modified ? new Date(b.modified).getTime() : 0;
          return bTime - aTime;
        });
        const newest = sorted[0];
        if (newest?.fullPath && existsSync(newest.fullPath)) {
          debug("log", `findClaudeLogPath: fallback to most recent via index -> ${newest.fullPath}`);
          return newest.fullPath;
        }
      }
    } catch (err) {
      debugError("findClaudeLogPath:index-fallback", err);
    }
  }

  // Final fallback: most recently modified .jsonl file (for projects without index)
  try {
    const files = readdirSync(claudeProjectDir)
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => {
        const fullPath = path.join(claudeProjectDir, f);
        return { path: fullPath, mtime: statSync(fullPath).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length > 0) {
      debug("log", `findClaudeLogPath: fallback to most recent file -> ${files[0].path}`);
      return files[0].path;
    }
  } catch (err) {
    debugError("findClaudeLogPath:file-fallback", err);
  }

  debug("log", `findClaudeLogPath: not found`);
  return null;
}

/**
 * Find the most recently created Claude session UUID for a project.
 * @param {string} sessionName - tmux session name (used to get cwd)
 * @returns {string | null}
 */
function findNewestClaudeSessionUuid(sessionName) {
  const cwd = getTmuxSessionCwd(sessionName) || process.cwd();
  const projectPath = getClaudeProjectPath(cwd);
  const claudeProjectDir = path.join(
    CLAUDE_CONFIG_DIR,
    "projects",
    projectPath
  );
  const indexPath = path.join(claudeProjectDir, "sessions-index.json");

  if (!existsSync(indexPath)) {
    debug("log", `findNewestClaudeSessionUuid: no index at ${indexPath}`);
    return null;
  }

  try {
    const index = JSON.parse(readFileSync(indexPath, "utf-8"));
    if (!index.entries?.length) return null;

    // Sort by created timestamp (most recent first)
    const sorted = [...index.entries].sort((a, b) => {
      const aTime = a.created ? new Date(a.created).getTime() : 0;
      const bTime = b.created ? new Date(b.created).getTime() : 0;
      return bTime - aTime;
    });

    const newest = sorted[0];
    debug("log", `findNewestClaudeSessionUuid: newest=${newest.sessionId}`);
    return newest.sessionId;
  } catch (err) {
    debugError("findNewestClaudeSessionUuid", err);
    return null;
  }
}

/**
 * Find Codex log path by checking which .jsonl file the Codex process has open.
 * Uses lsof as the source of truth - whatever file the process has open is the current log.
 * Falls back to timestamp-based matching if lsof fails.
 * @param {string} sessionName
 * @returns {string | null}
 */
function findCodexLogPath(sessionName) {
  debug("log", `findCodexLogPath: sessionName=${sessionName}`);

  // Primary method: find the log file via lsof (what file does Codex have open?)
  try {
    // Get tmux pane PID
    const paneResult = spawnSync(
      "tmux",
      ["list-panes", "-t", sessionName, "-F", "#{pane_pid}"],
      { encoding: "utf-8" }
    );
    if (paneResult.status === 0 && paneResult.stdout.trim()) {
      const panePid = parseInt(paneResult.stdout.trim().split("\n")[0], 10);
      if (!isNaN(panePid)) {
        // Find child process named "codex"
        const pgrepResult = spawnSync("pgrep", ["-P", panePid.toString(), "-x", "codex"], {
          encoding: "utf-8",
        });
        if (pgrepResult.status === 0 && pgrepResult.stdout.trim()) {
          const codexPid = parseInt(pgrepResult.stdout.trim().split("\n")[0], 10);
          if (!isNaN(codexPid)) {
            // Use lsof to find which .jsonl file it has open
            const lsofResult = spawnSync("lsof", ["-p", codexPid.toString()], {
              encoding: "utf-8",
            });
            if (lsofResult.status === 0) {
              const match = lsofResult.stdout.match(/(\S+\.jsonl)\s*$/m);
              if (match) {
                debug("log", `findCodexLogPath: lsof found ${match[1]}`);
                return match[1];
              }
            }
          }
        }
      }
    }
    debug("log", `findCodexLogPath: lsof method failed, falling back to timestamp`);
  } catch (err) {
    debug("log", `findCodexLogPath: lsof exception, falling back to timestamp`);
  }

  // Fallback: timestamp-based matching (for when process isn't running or lsof fails)
  try {
    const result = spawnSync(
      "tmux",
      ["display-message", "-t", sessionName, "-p", "#{session_created}"],
      {
        encoding: "utf-8",
      }
    );
    if (result.status !== 0) {
      debug("log", `findCodexLogPath: tmux display-message failed`);
      return null;
    }
    const createdTs = parseInt(result.stdout.trim(), 10) * 1000; // tmux gives seconds, we need ms
    if (isNaN(createdTs)) {
      debug("log", `findCodexLogPath: invalid timestamp`);
      return null;
    }

    // Codex stores sessions in ~/.codex/sessions/YYYY/MM/DD/rollout-TIMESTAMP-UUID.jsonl
    const sessionsDir = path.join(CODEX_CONFIG_DIR, "sessions");
    if (!existsSync(sessionsDir)) {
      debug("log", `findCodexLogPath: sessions dir not found`);
      return null;
    }

    const startDate = new Date(createdTs);
    const year = startDate.getFullYear().toString();
    const month = String(startDate.getMonth() + 1).padStart(2, "0");
    const day = String(startDate.getDate()).padStart(2, "0");

    const dayDir = path.join(sessionsDir, year, month, day);
    if (!existsSync(dayDir)) {
      debug("log", `findCodexLogPath: day dir not found: ${dayDir}`);
      return null;
    }

    // Find the closest log file created after the tmux session started
    // Use 60-second window to handle slow startups (model download, first run, heavy load)
    const files = readdirSync(dayDir).filter((f) => f.endsWith(".jsonl"));
    debug("log", `findCodexLogPath: ${files.length} jsonl files in ${dayDir}`);
    const candidates = [];

    for (const file of files) {
      // Parse timestamp from filename: rollout-2026-01-22T13-05-15-UUID.jsonl
      const match = file.match(
        /^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/
      );
      if (!match) continue;

      const [, y, mo, d, h, mi, s] = match;
      const fileTime = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}Z`).getTime();
      const diff = fileTime - createdTs;

      // Log file should be created shortly after session start
      // Allow small negative diff (-2s) for clock skew, up to 60s for slow starts
      if (diff >= -2000 && diff < 60000) {
        candidates.push({
          file,
          diff: Math.abs(diff),
          path: path.join(dayDir, file),
        });
      }
    }

    if (candidates.length === 0) {
      debug("log", `findCodexLogPath: no candidates within time window`);
      return null;
    }
    // Return the closest match
    candidates.sort((a, b) => a.diff - b.diff);
    debug(
      "log",
      `findCodexLogPath: found ${candidates.length} candidates, best: ${candidates[0].path}`
    );
    return candidates[0].path;
  } catch {
    debug("log", `findCodexLogPath: exception caught`);
    return null;
  }
}

/**
 * @typedef {Object} SessionMeta
 * @property {string | null} slug - Plan identifier (if plan is active)
 * @property {Array<{content: string, status: string, id?: string}> | null} todos - Current todos
 * @property {string | null} permissionMode - "default", "acceptEdits", "plan"
 * @property {string | null} gitBranch - Current git branch
 * @property {string | null} cwd - Working directory
 */

/**
 * Get metadata from a Claude session's JSONL file.
 * Returns null for Codex sessions (different format, no equivalent metadata).
 * @param {string} sessionName - The tmux session name
 * @returns {SessionMeta | null}
 */
function getSessionMeta(sessionName) {
  const parsed = parseSessionName(sessionName);
  if (!parsed) return null;

  // Only Claude sessions have this metadata
  if (parsed.tool !== "claude") return null;
  if (!parsed.uuid) return null;

  const logPath = findClaudeLogPath(parsed.uuid, sessionName);
  if (!logPath || !existsSync(logPath)) return null;

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Read from end to find most recent entry with metadata
    for (let i = lines.length - 1; i >= 0; i--) {
      try {
        const entry = JSON.parse(lines[i]);
        // User entries typically have the metadata fields
        if (entry.type === "user" || entry.slug || entry.gitBranch) {
          return {
            slug: entry.slug || null,
            todos: entry.todos || null,
            permissionMode: entry.permissionMode || null,
            gitBranch: entry.gitBranch || null,
            cwd: entry.cwd || null,
          };
        }
      } catch {
        // Skip malformed lines
      }
    }
    return null;
  } catch (err) {
    debugError("getSessionMeta", err);
    return null;
  }
}

/**
 * Read a plan file by its slug.
 * @param {string} slug - The plan slug (e.g., "curious-roaming-pascal")
 * @returns {string | null} The plan content or null if not found
 */
function readPlanFile(slug) {
  const planPath = path.join(CLAUDE_CONFIG_DIR, "plans", `${slug}.md`);
  try {
    if (existsSync(planPath)) {
      return readFileSync(planPath, "utf-8");
    }
  } catch (err) {
    debugError("readPlanFile", err);
  }
  return null;
}

/**
 * Format todos for display in a prompt.
 * @param {Array<{content: string, status: string, id?: string}>} todos
 * @returns {string}
 */
function formatTodos(todos) {
  if (!todos || todos.length === 0) return "";
  return todos
    .map((t) => {
      const status =
        t.status === "completed"
          ? "[x]"
          : t.status === "in_progress"
          ? "[>]"
          : "[ ]";
      return `${status} ${t.content || "(no content)"}`;
    })
    .join("\n");
}

/**
 * Extract assistant text responses from a JSONL log file.
 * This provides clean text without screen-scraped artifacts.
 * @param {string} logPath - Path to the JSONL log file
 * @param {number} [index=0] - 0 = last response, -1 = second-to-last, etc.
 * @returns {string | null} The assistant text or null if not found
 */
function getAssistantText(logPath, index = 0) {
  if (!logPath || !existsSync(logPath)) return null;

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Collect all assistant entries with text (from end, for efficiency)
    const assistantTexts = [];
    const needed = Math.abs(index) + 1;

    for (
      let i = lines.length - 1;
      i >= 0 && assistantTexts.length < needed;
      i--
    ) {
      try {
        const entry = JSON.parse(lines[i]);
        if (entry.type === "assistant") {
          /** @type {{type: string, text?: string}[]} */
          const parts = entry.message?.content || [];
          const text = parts
            .filter((p) => p.type === "text")
            .map((p) => p.text || "")
            .join("\n")
            .trim();
          if (text) assistantTexts.push(text);
        }
      } catch (err) {
        debugError("getAssistantText:parse", err);
      }
    }

    // index=0 means last (assistantTexts[0]), index=-1 means second-to-last (assistantTexts[1])
    const targetIndex = Math.abs(index);
    return assistantTexts[targetIndex] ?? null;
  } catch (err) {
    debugError("getAssistantText", err);
    return null;
  }
}

/**
 * Read new complete JSON lines from a log file since the given offset.
 * @param {string | null} logPath
 * @param {number} fromOffset
 * @returns {{ entries: object[], newOffset: number }}
 */
function tailJsonl(logPath, fromOffset) {
  if (!logPath || !existsSync(logPath)) {
    return { entries: [], newOffset: fromOffset };
  }

  const stats = statSync(logPath);
  if (stats.size <= fromOffset) {
    return { entries: [], newOffset: fromOffset };
  }

  const fd = openSync(logPath, "r");
  const buffer = Buffer.alloc(stats.size - fromOffset);
  readSync(fd, buffer, 0, buffer.length, fromOffset);
  closeSync(fd);

  const text = buffer.toString("utf-8");
  const lines = text.split("\n");

  // Last line may be incomplete - don't parse it yet
  const complete = lines.slice(0, -1).filter(Boolean);
  const incomplete = lines[lines.length - 1];

  const entries = [];
  for (const line of complete) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  // Offset advances by complete lines only
  const newOffset = fromOffset + text.length - incomplete.length;
  return { entries, newOffset };
}

/**
 * @typedef {{command?: string, file_path?: string, path?: string, pattern?: string}} ToolInput
 */

/**
 * Format a Claude Code JSONL log entry for streaming display.
 * Claude format: {type: "assistant", message: {content: [...]}}
 * @param {{type?: string, message?: {content?: Array<{type?: string, text?: string, thinking?: string, name?: string, input?: ToolInput, tool?: string, arguments?: ToolInput}>}}} entry
 * @returns {string | null}
 */
/**
 * Format a Claude JSONL log entry for streaming display.
 * @param {{type?: string, message?: {content?: Array<{type?: string, text?: string, thinking?: string, name?: string, tool?: string, input?: {command?: string, file_path?: string, path?: string, pattern?: string, description?: string, subagent_type?: string}, arguments?: {command?: string, file_path?: string, path?: string, pattern?: string, description?: string, subagent_type?: string}}>}}} entry
 * @returns {LogSegment[] | null}
 */
function formatClaudeLogEntry(entry) {
  // Skip tool_result entries (they can be very verbose)
  if (entry.type === "tool_result") return null;

  // Only process assistant entries
  if (entry.type !== "assistant") return null;

  const parts = entry.message?.content || [];
  /** @type {LogSegment[]} */
  const output = [];

  for (const part of parts) {
    if (part.type === "text" && part.text) {
      output.push({ type: "text", content: part.text });
    } else if (part.type === "thinking" && part.thinking) {
      // Include thinking blocks - extended thinking models put responses here
      output.push({ type: "thinking", content: part.thinking });
    } else if (part.type === "tool_use" || part.type === "tool_call") {
      const name = part.name || part.tool || "tool";
      const input = part.input || part.arguments || {};
      let summary;
      if (name === "Bash" && input.command) {
        summary = truncate(input.command, 50);
      } else if (
        name === "Task" &&
        (input.description || input.subagent_type)
      ) {
        // Task tool: show description or subagent type
        summary = input.description || input.subagent_type || "";
        summary = truncate(summary, 40);
      } else {
        const target = input.file_path || input.path || input.pattern || "";
        summary = target.split("/").pop() || truncate(target, 30);
      }
      output.push({ type: "tool", content: `> ${name}(${summary})` });
    }
  }

  return output.length > 0 ? output : null;
}

/**
 * Format a Codex JSONL log entry for streaming display.
 * Codex format:
 * - {type: "response_item", payload: {type: "message", role: "assistant", content: [{type: "output_text", text: "..."}]}}
 * - {type: "response_item", payload: {type: "function_call", name: "...", arguments: "{...}"}}
 * - {type: "event_msg", payload: {type: "agent_message", message: "..."}}
 * - {type: "event_msg", payload: {type: "agent_reasoning", text: "..."}}
 * @param {{type?: string, payload?: {type?: string, role?: string, name?: string, arguments?: string, message?: string, text?: string, content?: Array<{type?: string, text?: string}>}}} entry
 * @returns {LogSegment[] | null}
 */
function formatCodexLogEntry(entry) {
  // Skip function_call_output entries (equivalent to tool_result - can be verbose)
  if (
    entry.type === "response_item" &&
    entry.payload?.type === "function_call_output"
  ) {
    return null;
  }

  // Handle function calls
  if (
    entry.type === "response_item" &&
    entry.payload?.type === "function_call"
  ) {
    const name = entry.payload.name || "tool";
    let summary = "";
    try {
      const args = JSON.parse(entry.payload.arguments || "{}");
      if (name === "shell_command" && args.command) {
        summary = truncate(args.command, 50);
      } else if (name === "Task" && (args.description || args.subagent_type)) {
        // Task tool: show description or subagent type
        summary = args.description || args.subagent_type || "";
        summary = truncate(summary, 40);
      } else {
        const target = args.file_path || args.path || args.pattern || "";
        summary = target.split("/").pop() || truncate(target, 30);
      }
    } catch {
      summary = "...";
    }
    return [{ type: "tool", content: `> ${name}(${summary})` }];
  }

  // Handle assistant messages (final response)
  if (entry.type === "response_item" && entry.payload?.role === "assistant") {
    const parts = entry.payload.content || [];
    /** @type {LogSegment[]} */
    const output = [];
    for (const part of parts) {
      if ((part.type === "output_text" || part.type === "text") && part.text) {
        output.push({ type: "text", content: part.text });
      }
    }
    return output.length > 0 ? output : null;
  }

  // Handle streaming agent messages
  if (entry.type === "event_msg" && entry.payload?.type === "agent_message") {
    const message = entry.payload.message;
    return message ? [{ type: "text", content: message }] : null;
  }

  // Handle agent reasoning (thinking during review)
  if (entry.type === "event_msg" && entry.payload?.type === "agent_reasoning") {
    const text = entry.payload.text;
    return text ? [{ type: "thinking", content: text }] : null;
  }

  return null;
}

// =============================================================================
// Terminal Stream Primitives - Pure functions for parsing terminal data
// =============================================================================

/**
 * Parse a JSONL log entry into TerminalLine[].
 * Wraps formatClaudeLogEntry/formatCodexLogEntry to return structured data.
 * @param {object} entry - A parsed JSONL entry
 * @param {'claude' | 'codex'} format - The log format
 * @returns {TerminalLine[]}
 */
function parseJsonlEntry(entry, format) {
  const segments =
    format === "claude"
      ? formatClaudeLogEntry(entry)
      : formatCodexLogEntry(entry);
  if (!segments) return [];

  // Convert segments to TerminalLines, splitting multiline content
  /** @type {TerminalLine[]} */
  const lines = [];
  for (const segment of segments) {
    const contentLines = segment.content.split("\n");
    for (const line of contentLines) {
      lines.push({
        spans: [{ text: line }],
        raw: line,
        lineType: segment.type,
      });
    }
  }
  return lines;
}

/**
 * Parse raw screen output into TerminalLine[].
 * Each line becomes a TerminalLine with a single unstyled span.
 * @param {string} screen - Raw screen content from tmux capture
 * @returns {TerminalLine[]}
 */
function parseScreenLines(screen) {
  if (!screen) return [];
  return screen.split("\n").map((line) => ({
    spans: [{ text: line }],
    raw: line,
  }));
}

/**
 * ANSI color code to color name mapping.
 * @type {Record<string, string>}
 */
const ANSI_COLORS = {
  30: "black",
  31: "red",
  32: "green",
  33: "yellow",
  34: "blue",
  35: "magenta",
  36: "cyan",
  37: "white",
  90: "bright-black",
  91: "bright-red",
  92: "bright-green",
  93: "bright-yellow",
  94: "bright-blue",
  95: "bright-magenta",
  96: "bright-cyan",
  97: "bright-white",
};

/**
 * ANSI background color code to color name mapping.
 * @type {Record<string, string>}
 */
const ANSI_BG_COLORS = {
  40: "black",
  41: "red",
  42: "green",
  43: "yellow",
  44: "blue",
  45: "magenta",
  46: "cyan",
  47: "white",
  100: "bright-black",
  101: "bright-red",
  102: "bright-green",
  103: "bright-yellow",
  104: "bright-blue",
  105: "bright-magenta",
  106: "bright-cyan",
  107: "bright-white",
};

/**
 * Parse ANSI escape sequences from a line of text into styled spans.
 * @param {string} line - Line containing ANSI escape sequences
 * @returns {TextSpan[]}
 */
function parseAnsiLine(line) {
  if (!line) return [{ text: "" }];

  const spans = [];
  /** @type {TerminalStyle} */
  let currentStyle = {};
  let currentText = "";

  // ANSI escape sequence pattern: ESC [ <params> m
  // Matches sequences like \x1b[31m (red), \x1b[1;31m (bold red), \x1b[0m (reset)
  // eslint-disable-next-line no-control-regex
  const ansiPattern = /\x1b\[([0-9;]*)m/g;
  let lastIndex = 0;
  let match;

  while ((match = ansiPattern.exec(line)) !== null) {
    // Add text before this escape sequence
    const textBefore = line.slice(lastIndex, match.index);
    if (textBefore) {
      currentText += textBefore;
    }

    // Flush current span if we have text
    if (currentText) {
      /** @type {TextSpan} */
      const span = { text: currentText };
      if (Object.keys(currentStyle).length > 0) {
        span.style = { ...currentStyle };
      }
      spans.push(span);
      currentText = "";
    }

    // Parse SGR (Select Graphic Rendition) parameters
    // Note: \x1b[m (empty params) is equivalent to \x1b[0m (reset)
    const params = match[1].split(";").filter(Boolean);
    if (params.length === 0) {
      // Empty params means reset (e.g., \x1b[m)
      currentStyle = {};
    }
    for (const param of params) {
      const code = param;
      if (code === "0") {
        // Reset
        currentStyle = {};
      } else if (code === "1") {
        currentStyle.bold = true;
      } else if (code === "2") {
        currentStyle.dim = true;
      } else if (code === "3") {
        currentStyle.italic = true;
      } else if (code === "4") {
        currentStyle.underline = true;
      } else if (code === "22") {
        // Normal intensity (neither bold nor dim)
        delete currentStyle.bold;
        delete currentStyle.dim;
      } else if (code === "23") {
        delete currentStyle.italic;
      } else if (code === "24") {
        delete currentStyle.underline;
      } else if (ANSI_COLORS[code]) {
        currentStyle.fg = ANSI_COLORS[code];
      } else if (ANSI_BG_COLORS[code]) {
        currentStyle.bg = ANSI_BG_COLORS[code];
      } else if (code === "39") {
        // Default foreground
        delete currentStyle.fg;
      } else if (code === "49") {
        // Default background
        delete currentStyle.bg;
      }
    }

    lastIndex = ansiPattern.lastIndex;
  }

  // Add remaining text
  const remaining = line.slice(lastIndex);
  if (remaining) {
    currentText += remaining;
  }

  // Flush final span
  if (currentText || spans.length === 0) {
    /** @type {TextSpan} */
    const span = { text: currentText };
    if (Object.keys(currentStyle).length > 0) {
      span.style = { ...currentStyle };
    }
    spans.push(span);
  }

  return spans;
}

/**
 * Parse raw screen output with ANSI codes into styled TerminalLine[].
 * @param {string} screen - Screen content with ANSI escape codes
 * @returns {TerminalLine[]}
 */
function parseStyledScreenLines(screen) {
  if (!screen) return [];
  return screen.split("\n").map((line) => {
    const spans = parseAnsiLine(line);
    // Raw text is spans joined without styles
    const raw = spans.map((s) => s.text).join("");
    return { spans, raw };
  });
}

/**
 * Find a line matching the given query.
 * Style filters are ignored when lines don't have style information.
 * @param {TerminalLine[]} lines - Lines to search
 * @param {MatchQuery} query - Query with pattern and optional style filter
 * @returns {MatchResult}
 */
function findMatch(lines, query) {
  const { pattern, style } = query;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const text = line.raw;

    // Check pattern match
    const patternMatches =
      typeof pattern === "string" ? text.includes(pattern) : pattern.test(text);

    if (!patternMatches) continue;

    // If no style filter requested, we have a match
    if (!style) {
      return { matched: true, line, lineIndex: i };
    }

    // Check style match (if line has styled spans)
    // Style filter is silently ignored if implementation doesn't provide styles
    const hasStyledSpans = line.spans.some((span) => span.style);
    if (!hasStyledSpans) {
      // No style info available - pattern match is enough
      return { matched: true, line, lineIndex: i };
    }

    // Check if any span matches both pattern and style
    const styleMatches = line.spans.some((span) => {
      if (!span.style) return false;
      const spanMatchesPattern =
        typeof pattern === "string"
          ? span.text.includes(pattern)
          : pattern.test(span.text);
      if (!spanMatchesPattern) return false;

      // Check each requested style property
      const spanStyle = /** @type {Record<string, unknown>} */ (span.style);
      for (const [key, value] of Object.entries(style)) {
        if (spanStyle[key] !== value) return false;
      }
      return true;
    });

    if (styleMatches) {
      return { matched: true, line, lineIndex: i };
    }
  }

  return { matched: false };
}

// =============================================================================
// Terminal Stream Implementations
// =============================================================================

/**
 * Terminal stream that reads from JSONL log files (Claude/Codex logs).
 * Implements TerminalStream interface.
 * @implements {TerminalStream}
 */
class JsonlTerminalStream {
  /** @type {() => string | null} */
  logPathFinder;
  /** @type {'claude' | 'codex'} */
  format;
  /** @type {string | null} */
  logPath;
  /** @type {number} */
  offset;
  /** @type {boolean} */
  skipExisting;
  /** @type {boolean} */
  initialized;

  /**
   * @param {() => string | null} logPathFinder - Function that returns current log path (may change during session)
   * @param {'claude' | 'codex'} format - Log format for parsing entries
   * @param {{skipExisting?: boolean}} [opts] - Options
   */
  constructor(logPathFinder, format, opts = {}) {
    this.logPathFinder = logPathFinder;
    this.format = format;
    this.logPath = null;
    this.offset = 0;
    this.skipExisting = opts.skipExisting ?? false;
    this.initialized = false;
  }

  /**
   * Read new lines since last read.
   * @param {ReadOptions} [opts]
   * @returns {Promise<TerminalLine[]>}
   */
  async readNext(opts = {}) {
    // Check for new/changed log path
    const currentLogPath = this.logPathFinder();
    if (currentLogPath && currentLogPath !== this.logPath) {
      this.logPath = currentLogPath;
      if (existsSync(this.logPath)) {
        if (this.skipExisting && !this.initialized) {
          // Skip to end of file - only read new content
          this.offset = statSync(this.logPath).size;
          this.initialized = true;
        } else {
          // Read from beginning
          this.offset = 0;
        }
      }
    }

    if (!this.logPath) {
      return [];
    }

    const { entries, newOffset } = tailJsonl(this.logPath, this.offset);
    this.offset = newOffset;

    const lines = [];
    for (const entry of entries) {
      const entryLines = parseJsonlEntry(entry, this.format);
      lines.push(...entryLines);
    }

    if (opts.max && lines.length > opts.max) {
      return lines.slice(0, opts.max);
    }

    return lines;
  }

  /**
   * Wait for a line matching the query.
   * @param {MatchQuery} query
   * @param {WaitOptions} [opts]
   * @returns {Promise<MatchResult>}
   */
  async waitForMatch(query, opts = {}) {
    const timeoutMs = opts.timeoutMs || 30000;
    const pollInterval = 100;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const lines = await this.readNext();
      if (lines.length > 0) {
        const result = findMatch(lines, query);
        if (result.matched) {
          return result;
        }
      }
      await sleep(pollInterval);
    }

    return { matched: false };
  }
}

/**
 * Terminal stream that reads from tmux screen capture.
 * Implements TerminalStream interface.
 * @implements {TerminalStream}
 */
class ScreenTerminalStream {
  /**
   * @param {string} session - tmux session name
   * @param {number} [scrollback] - Number of scrollback lines to capture
   */
  constructor(session, scrollback = 0) {
    this.session = session;
    this.scrollback = scrollback;
    this.lastScreen = "";
  }

  /**
   * Read current screen lines (returns all visible lines on each call).
   * Note: Unlike JsonlTerminalStream, this returns the full screen each time.
   * @param {ReadOptions} [opts]
   * @returns {Promise<TerminalLine[]>}
   */
  async readNext(opts = {}) {
    const screen = tmuxCapture(this.session, this.scrollback);
    this.lastScreen = screen;

    const lines = parseScreenLines(screen);

    if (opts.max && lines.length > opts.max) {
      return lines.slice(-opts.max); // Return last N lines for screen capture
    }

    return lines;
  }

  /**
   * Wait for a line matching the query.
   * @param {MatchQuery} query
   * @param {WaitOptions} [opts]
   * @returns {Promise<MatchResult>}
   */
  async waitForMatch(query, opts = {}) {
    const timeoutMs = opts.timeoutMs || 30000;
    const pollInterval = 100;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const lines = await this.readNext();
      const result = findMatch(lines, query);
      if (result.matched) {
        return result;
      }
      await sleep(pollInterval);
    }

    return { matched: false };
  }

  /**
   * Get the last captured screen (raw string).
   * Useful for compatibility with existing code that needs raw screen.
   * @returns {string}
   */
  getLastScreen() {
    return this.lastScreen;
  }
}

/**
 * Terminal stream that reads from tmux screen capture with ANSI styling.
 * Uses `tmux capture-pane -e` to capture escape sequences.
 * Implements TerminalStream interface.
 * @implements {TerminalStream}
 */
class StyledScreenTerminalStream {
  /**
   * @param {string} session - tmux session name
   * @param {number} [scrollback] - Number of scrollback lines to capture
   */
  constructor(session, scrollback = 0) {
    this.session = session;
    this.scrollback = scrollback;
    this.lastScreen = "";
  }

  /**
   * Read current screen lines with ANSI styling parsed.
   * @param {ReadOptions} [opts]
   * @returns {Promise<TerminalLine[]>}
   */
  async readNext(opts = {}) {
    const screen = tmuxCapture(this.session, this.scrollback, true); // withEscapes=true
    this.lastScreen = screen;

    const lines = parseStyledScreenLines(screen);

    if (opts.max && lines.length > opts.max) {
      return lines.slice(-opts.max); // Return last N lines for screen capture
    }

    return lines;
  }

  /**
   * Wait for a line matching the query (supports style-aware matching).
   * @param {MatchQuery} query
   * @param {WaitOptions} [opts]
   * @returns {Promise<MatchResult>}
   */
  async waitForMatch(query, opts = {}) {
    const timeoutMs = opts.timeoutMs || 30000;
    const pollInterval = 100;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const lines = await this.readNext();
      const result = findMatch(lines, query);
      if (result.matched) {
        return result;
      }
      await sleep(pollInterval);
    }

    return { matched: false };
  }

  /**
   * Get the last captured screen (raw string with ANSI codes).
   * @returns {string}
   */
  getLastScreen() {
    return this.lastScreen;
  }
}

/**
 * Fake terminal stream for testing.
 * Implements TerminalStream interface.
 * @implements {TerminalStream}
 */
class FakeTerminalStream {
  /**
   * @param {TerminalLine[]} lines - Initial lines to provide
   */
  constructor(lines = []) {
    this.lines = [...lines];
    this.readCount = 0;
    /** @type {TerminalLine[][]} */
    this.pendingLines = [];
  }

  /**
   * Queue lines to be returned on subsequent readNext calls.
   * @param {TerminalLine[]} lines
   */
  queueLines(lines) {
    this.pendingLines.push(lines);
  }

  /**
   * Add more lines to the current buffer (simulates new output).
   * @param {TerminalLine[]} lines
   */
  addLines(lines) {
    this.lines.push(...lines);
  }

  /**
   * Read new lines since last read.
   * First call returns initial lines, subsequent calls return queued lines.
   * @param {ReadOptions} [opts]
   * @returns {Promise<TerminalLine[]>}
   */
  async readNext(opts = {}) {
    this.readCount++;

    /** @type {TerminalLine[]} */
    let result = [];
    if (this.readCount === 1) {
      result = this.lines;
    } else if (this.pendingLines.length > 0) {
      result = this.pendingLines.shift() || [];
    }

    if (opts.max && result.length > opts.max) {
      return result.slice(0, opts.max);
    }

    return result;
  }

  /**
   * Wait for a line matching the query.
   * Immediately checks available lines without polling.
   * @param {MatchQuery} query
   * @param {WaitOptions} [_opts]
   * @returns {Promise<MatchResult>}
   */
  async waitForMatch(query, _opts = {}) {
    // Check initial lines
    const result = findMatch(this.lines, query);
    if (result.matched) {
      return result;
    }

    // Check all pending lines
    for (const pendingBatch of this.pendingLines) {
      const batchResult = findMatch(pendingBatch, query);
      if (batchResult.matched) {
        return batchResult;
      }
    }

    return { matched: false };
  }

  /**
   * Create a TerminalLine from a raw string (helper for tests).
   * @param {string} raw
   * @returns {TerminalLine}
   */
  static line(raw) {
    return { spans: [{ text: raw }], raw };
  }

  /**
   * Create multiple TerminalLines from raw strings (helper for tests).
   * @param {string[]} raws
   * @returns {TerminalLine[]}
   */
  static lines(raws) {
    return raws.map((raw) => FakeTerminalStream.line(raw));
  }
}

/**
 * Extract pending tool from confirmation screen.
 * @param {string} screen
 * @returns {string | null}
 */
function extractPendingToolFromScreen(screen) {
  const lines = screen.split("\n");

  // Check recent lines for tool confirmation patterns
  for (let i = lines.length - 1; i >= Math.max(0, lines.length - 15); i--) {
    const line = lines[i];
    // Match tool confirmation patterns like "Bash: command" or "Write: /path/file"
    const match = line.match(
      /^\s*(Bash|Write|Edit|Read|Glob|Grep|Task|WebFetch|WebSearch|NotebookEdit|Skill|TodoWrite|TodoRead):\s*(.{1,40})/
    );
    if (match) {
      return `${match[1]}: ${match[2].trim()}`;
    }
  }

  return null;
}

/**
 * Format confirmation output with helpful commands
 * @param {string} screen
 * @param {Agent} _agent
 * @returns {string}
 */
function formatConfirmationOutput(screen, _agent) {
  const pendingTool = extractPendingToolFromScreen(screen);
  const cli = path.basename(process.argv[1], ".js");

  let output = pendingTool || "Confirmation required";
  output += "\n\ne.g.";
  output += `\n  ${cli} approve        # for y/n prompts`;
  output += `\n  ${cli} reject`;
  output += `\n  ${cli} select N       # for numbered menus`;

  return output;
}

/**
 * @returns {string[]}
 */
function tmuxListSessions() {
  try {
    const output = tmux(["list-sessions", "-F", "#{session_name}"]);
    return output.trim().split("\n").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * @param {string} partial
 * @returns {string | null}
 */
function resolveSessionName(partial) {
  if (!partial) return null;

  const sessions = tmuxListSessions();
  const agentSessions = sessions.filter((s) => parseSessionName(s));
  debug(
    "session",
    `resolving "${partial}" from ${agentSessions.length} agent sessions`
  );

  // Exact match
  if (agentSessions.includes(partial)) {
    debug("session", `exact match: ${partial}`);
    return partial;
  }

  // Archangel name match (e.g., "reviewer" matches "claude-archangel-reviewer-uuid")
  const archangelMatches = agentSessions.filter((s) => {
    const parsed = parseSessionName(s);
    return parsed?.archangelName === partial;
  });
  if (archangelMatches.length === 1) {
    debug("session", `archangel match: ${archangelMatches[0]}`);
    return archangelMatches[0];
  }
  if (archangelMatches.length > 1) {
    console.log("ERROR: ambiguous archangel name. Matches:");
    for (const m of archangelMatches) console.log(`  ${m}`);
    process.exit(1);
  }

  // Prefix match
  const matches = agentSessions.filter((s) => s.startsWith(partial));
  if (matches.length === 1) {
    debug("session", `prefix match: ${matches[0]}`);
    return matches[0];
  }
  if (matches.length > 1) {
    console.log("ERROR: ambiguous session prefix. Matches:");
    for (const m of matches) console.log(`  ${m}`);
    process.exit(1);
  }

  // Partial UUID match (e.g., "33fe38" matches "claude-partner-33fe38b1-...")
  const uuidMatches = agentSessions.filter((s) => {
    const parsed = parseSessionName(s);
    return parsed?.uuid?.startsWith(partial);
  });
  if (uuidMatches.length === 1) {
    debug("session", `UUID match: ${uuidMatches[0]}`);
    return uuidMatches[0];
  }
  if (uuidMatches.length > 1) {
    console.log("ERROR: ambiguous UUID prefix. Matches:");
    for (const m of uuidMatches) console.log(`  ${m}`);
    process.exit(1);
  }

  debug("session", `no match found, returning as-is: ${partial}`);
  return partial; // Return as-is, let caller handle not found
}

// =============================================================================
// Helpers - archangels
// =============================================================================

/**
 * @returns {ArchangelConfig[]}
 */
function loadAgentConfigs() {
  const agentsDir = AGENTS_DIR;
  if (!existsSync(agentsDir)) return [];

  const files = readdirSync(agentsDir).filter((f) => f.endsWith(".md"));
  /** @type {ArchangelConfig[]} */
  const configs = [];

  for (const file of files) {
    try {
      const content = readFileSync(path.join(agentsDir, file), "utf-8");
      const config = parseAgentConfig(file, content);
      if (config && "error" in config) {
        console.error(`ERROR: ${file}: ${config.error}`);
        continue;
      }
      if (config) configs.push(config);
    } catch (err) {
      console.error(
        `ERROR: Failed to read ${file}: ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }

  return configs;
}

/**
 * @param {string} filename
 * @param {string} content
 * @returns {ArchangelConfig | {error: string} | null}
 */
function parseAgentConfig(filename, content) {
  const name = filename.replace(/\.md$/, "");

  // Normalize line endings (handle Windows CRLF)
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");

  // Parse frontmatter
  const frontmatterMatch = normalized.match(
    /^---\n([\s\S]*?)\n---\n([\s\S]*)$/
  );
  if (!frontmatterMatch) {
    if (!normalized.startsWith("---")) {
      return { error: `Missing frontmatter. File must start with '---'` };
    }
    if (!normalized.includes("\n---\n")) {
      return {
        error: `Frontmatter not closed. Add '---' on its own line after the YAML block`,
      };
    }
    return { error: `Invalid frontmatter format` };
  }

  const frontmatter = frontmatterMatch[1];
  const prompt = frontmatterMatch[2].trim();

  if (!prompt) {
    return { error: `Missing prompt content after frontmatter` };
  }

  // Known fields
  const knownFields = ["tool", "interval", "watch"];

  // Check for unknown fields (likely typos)
  const fieldLines = frontmatter
    .split("\n")
    .filter((line) => /^\w+:/.test(line.trim()));
  for (const line of fieldLines) {
    const fieldName = line.trim().match(/^(\w+):/)?.[1];
    if (fieldName && !knownFields.includes(fieldName)) {
      // Suggest closest match
      const suggestions = knownFields.filter(
        (f) => f[0] === fieldName[0] || fieldName.includes(f.slice(0, 3))
      );
      const hint =
        suggestions.length > 0 ? ` Did you mean '${suggestions[0]}'?` : "";
      return {
        error: `Unknown field '${fieldName}'.${hint} Valid fields: ${knownFields.join(
          ", "
        )}`,
      };
    }
  }

  // Parse tool
  const toolMatch = frontmatter.match(/^tool:\s*(\S+)/m);
  const tool = toolMatch?.[1] || "codex";
  if (tool !== "claude" && tool !== "codex") {
    return { error: `Invalid tool '${tool}'. Must be 'claude' or 'codex'` };
  }

  // Parse interval
  const intervalMatch = frontmatter.match(/^interval:\s*(.+)$/m);
  let interval = 60;
  if (intervalMatch) {
    const rawValue = intervalMatch[1].trim();
    const parsed = parseInt(rawValue, 10);
    if (isNaN(parsed)) {
      return {
        error: `Invalid interval '${rawValue}'. Must be a number (seconds)`,
      };
    }
    interval = Math.max(10, Math.min(3600, parsed)); // Clamp to 10s - 1hr
  }

  // Parse watch patterns
  const watchLine = frontmatter.match(/^watch:\s*(.+)$/m);
  let watchPatterns = ["**/*"];
  if (watchLine) {
    const rawWatch = watchLine[1].trim();
    // Must be array format
    if (!rawWatch.startsWith("[") || !rawWatch.endsWith("]")) {
      return {
        error: `Invalid watch format. Must be an array: watch: ["src/**/*.ts"]`,
      };
    }
    const inner = rawWatch.slice(1, -1).trim();
    if (!inner) {
      return {
        error: `Empty watch array. Add at least one pattern: watch: ["**/*"]`,
      };
    }
    watchPatterns = inner
      .split(",")
      .map((p) => p.trim().replace(/^["']|["']$/g, ""));
    // Validate patterns aren't empty
    if (watchPatterns.some((p) => !p)) {
      return {
        error: `Invalid watch pattern. Check for trailing commas or empty values`,
      };
    }
  }

  return { name, tool, watch: watchPatterns, interval, prompt };
}

/**
 * @param {ArchangelConfig} config
 * @returns {string}
 */
function getArchangelSessionPattern(config) {
  return `${config.tool}-archangel-${config.name}`;
}

/**
 * @param {string} rfpId
 * @param {string} prompt
 */
function writeRfpRecord(rfpId, prompt) {
  ensureRfpDir();
  const p = path.join(RFP_DIR, `${rfpId}.md`);
  const block = [`### ${rfpId}`, "", prompt.trim(), ""].join("\n");
  writeFileSync(p, block, "utf-8");
}

/**
 * @param {string} input
 * @returns {string}
 */
function resolveRfpId(input) {
  ensureRfpDir();
  if (!existsSync(RFP_DIR)) return input;
  const files = readdirSync(RFP_DIR).filter((f) => f.endsWith(".md"));
  const ids = files.map((f) => f.replace(/\.md$/, ""));
  const matches = ids.filter((id) => id.startsWith(input));
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    console.log("ERROR: ambiguous rfp id. Matches:");
    for (const m of matches) console.log(`  ${m}`);
    process.exit(1);
  }
  return input;
}

/**
 * @param {ParentSession | null} parent
 * @returns {string}
 */
function generateRfpId(parent) {
  const now = new Date();
  const y = now.getFullYear();
  const mo = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  const h = String(now.getHours()).padStart(2, "0");
  const mi = String(now.getMinutes()).padStart(2, "0");
  const s = String(now.getSeconds()).padStart(2, "0");
  const ts = `${y}-${mo}-${d}-${h}-${mi}-${s}`;
  const base = parent?.uuid
    ? parent.uuid.split("-")[0]
    : randomUUID().split("-")[0];
  const suffix = randomUUID().split("-")[0].slice(0, 4);
  return `rfp-${base}-${ts}-${suffix}`.toLowerCase();
}

// =============================================================================
// Helpers - mailbox
// =============================================================================

const MAILBOX_PATH = path.join(AI_DIR, "mailbox.jsonl");

/**
 * @returns {void}
 */
function ensureMailboxDir() {
  const dir = path.dirname(MAILBOX_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

/**
 * @returns {void}
 */
function ensureRfpDir() {
  if (!existsSync(RFP_DIR)) {
    mkdirSync(RFP_DIR, { recursive: true });
  }
}

/**
 * @param {MailboxPayload} payload
 * @param {string} [type]
 * @returns {void}
 */
function writeToMailbox(payload, type = "observation") {
  ensureMailboxDir();
  const entry = {
    timestamp: new Date().toISOString(),
    type,
    payload,
  };
  appendFileSync(MAILBOX_PATH, JSON.stringify(entry) + "\n");
}

/**
 * @param {Object} [options]
 * @param {number} [options.maxAge]
 * @param {string | null} [options.branch]
 * @param {number} [options.limit]
 * @returns {MailboxEntry[]}
 */
function readMailbox({
  maxAge = MAILBOX_MAX_AGE_MS,
  branch = null,
  limit = 10,
} = {}) {
  if (!existsSync(MAILBOX_PATH)) return [];

  const now = Date.now();
  const lines = readFileSync(MAILBOX_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  /** @type {MailboxEntry[]} */
  const entries = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const age = now - new Date(entry.timestamp).getTime();

      // Filter by age
      if (age > maxAge) continue;

      // Filter by branch if specified
      if (branch && entry.payload?.branch !== branch) continue;

      entries.push(entry);
    } catch (err) {
      debugError("readMailbox", err);
    }
  }

  // Return most recent entries
  return entries.slice(-limit);
}

/**
 * @param {number} [maxAgeHours]
 * @returns {void}
 */
function gcMailbox(maxAgeHours = 24) {
  if (!existsSync(MAILBOX_PATH)) return;

  const now = Date.now();
  const maxAgeMs = maxAgeHours * 60 * 60 * 1000;
  const lines = readFileSync(MAILBOX_PATH, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean);
  const kept = [];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      const age = now - new Date(entry.timestamp).getTime();
      if (age < maxAgeMs) kept.push(line);
    } catch {
      // Skip invalid lines
    }
  }

  // Atomic write: write to temp file then rename
  const tmpPath = MAILBOX_PATH + ".tmp";
  writeFileSync(tmpPath, kept.join("\n") + (kept.length ? "\n" : ""));
  renameSync(tmpPath, MAILBOX_PATH);
}

// =============================================================================
// Helpers - git
// =============================================================================

/** @returns {string} */
function getCurrentBranch() {
  try {
    return execSync("git branch --show-current 2>/dev/null", {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/** @returns {string} */
function getCurrentCommit() {
  try {
    return execSync("git rev-parse --short HEAD 2>/dev/null", {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "unknown";
  }
}

/** @returns {string} */
function getMainBranch() {
  try {
    execSync("git rev-parse --verify main 2>/dev/null");
    return "main";
  } catch {
    try {
      execSync("git rev-parse --verify master 2>/dev/null");
      return "master";
    } catch {
      return "main";
    }
  }
}

/** @returns {string} */
function getStagedDiff() {
  try {
    return execSync("git diff --cached 2>/dev/null", {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

/** @returns {string} */
function getUncommittedDiff() {
  try {
    return execSync("git diff 2>/dev/null", { encoding: "utf-8" }).trim();
  } catch {
    return "";
  }
}

/**
 * @param {number} [hoursAgo]
 * @returns {string}
 */
function getRecentCommitsDiff(hoursAgo = 4) {
  try {
    const mainBranch = getMainBranch();
    const since = `--since="${hoursAgo} hours ago"`;

    // Get list of commits in range
    const commits = execSync(
      `git log ${mainBranch}..HEAD ${since} --oneline 2>/dev/null`,
      {
        encoding: "utf-8",
      }
    ).trim();

    if (!commits) return "";

    // Get diff for those commits
    const firstCommit = commits
      .split("\n")
      .filter(Boolean)
      .pop()
      ?.split(" ")[0];
    if (!firstCommit) return "";
    return execSync(`git diff ${firstCommit}^..HEAD 2>/dev/null`, {
      encoding: "utf-8",
    }).trim();
  } catch {
    return "";
  }
}

/**
 * @param {string} diff
 * @param {number} [maxLines]
 * @returns {string}
 */
function truncateDiff(diff, maxLines = 200) {
  if (!diff) return "";
  const lines = diff.split("\n");
  if (lines.length <= maxLines) return diff;
  return (
    lines.slice(0, maxLines).join("\n") +
    `\n\n... (truncated, ${lines.length - maxLines} more lines)`
  );
}

/**
 * @param {number} [hoursAgo]
 * @param {number} [maxLinesPerSection]
 * @returns {string}
 */
function buildGitContext(hoursAgo = 4, maxLinesPerSection = 200) {
  const sections = [];

  const staged = truncateDiff(getStagedDiff(), maxLinesPerSection);
  if (staged) {
    sections.push(
      "## Staged Changes (about to be committed)\n```diff\n" + staged + "\n```"
    );
  }

  const uncommitted = truncateDiff(getUncommittedDiff(), maxLinesPerSection);
  if (uncommitted) {
    sections.push(
      "## Uncommitted Changes (work in progress)\n```diff\n" +
        uncommitted +
        "\n```"
    );
  }

  const recent = truncateDiff(
    getRecentCommitsDiff(hoursAgo),
    maxLinesPerSection
  );
  if (recent) {
    sections.push(
      `## Recent Commits (last ${hoursAgo} hours)\n\`\`\`diff\n` +
        recent +
        "\n```"
    );
  }

  return sections.join("\n\n");
}

// =============================================================================
// Helpers - parent session context
// =============================================================================

// Environment variables used to pass parent session info to archangels
const AX_ARCHANGEL_PARENT_SESSION_ENV = "AX_ARCHANGEL_PARENT_SESSION";
const AX_ARCHANGEL_PARENT_UUID_ENV = "AX_ARCHANGEL_PARENT_UUID";

/**
 * @returns {ParentSession | null}
 */
function findCurrentClaudeSession() {
  // If we're inside a tmux session, check if it's a Claude session
  const current = tmuxCurrentSession();
  if (current) {
    const parsed = parseSessionName(current);
    if (parsed?.tool === "claude" && !parsed.archangelName && parsed.uuid) {
      return { session: current, uuid: parsed.uuid };
    }
  }

  // We might be running from Claude but not inside tmux (e.g., VSCode, Cursor)
  // Find Claude sessions in the same cwd and pick the most recently active one
  const caller = findCallerAgent();
  if (!caller) return null;

  const cwd = process.cwd();
  const sessions = tmuxListSessions();
  const candidates = [];

  for (const session of sessions) {
    const parsed = parseSessionName(session);
    if (!parsed || parsed.tool !== "claude") continue;
    if (parsed.archangelName) continue;
    if (!parsed.uuid) continue;

    const sessionCwd = getTmuxSessionCwd(session);
    if (sessionCwd !== cwd) continue;

    // Check log file modification time
    const logPath = findClaudeLogPath(parsed.uuid, session);
    if (logPath && existsSync(logPath)) {
      try {
        const stat = statSync(logPath);
        candidates.push({ session, uuid: parsed.uuid, mtime: stat.mtimeMs });
      } catch (err) {
        debugError("findCurrentClaudeSession:stat", err);
      }
    }
  }

  // Also check non-tmux Claude sessions by scanning the project's log directory
  const projectPath = getClaudeProjectPath(cwd);
  const claudeProjectDir = path.join(
    CLAUDE_CONFIG_DIR,
    "projects",
    projectPath
  );
  if (existsSync(claudeProjectDir)) {
    try {
      const files = readdirSync(claudeProjectDir).filter((f) =>
        f.endsWith(".jsonl")
      );
      for (const file of files) {
        const uuid = file.replace(".jsonl", "");
        // Skip if we already have this from tmux sessions
        if (candidates.some((c) => c.uuid === uuid)) continue;

        const logPath = path.join(claudeProjectDir, file);
        try {
          const stat = statSync(logPath);
          // Only consider logs modified in the last hour (active sessions)
          if (Date.now() - stat.mtimeMs < MAILBOX_MAX_AGE_MS) {
            candidates.push({
              session: null,
              uuid,
              mtime: stat.mtimeMs,
              logPath,
            });
          }
        } catch (err) {
          debugError("findCurrentClaudeSession:logStat", err);
        }
      }
    } catch (err) {
      debugError("findCurrentClaudeSession:readdir", err);
    }
  }

  if (candidates.length === 0) return null;

  // Return the most recently active session
  candidates.sort((a, b) => b.mtime - a.mtime);
  return { session: candidates[0].session, uuid: candidates[0].uuid };
}

/**
 * @returns {ParentSession | null}
 */
function findParentSession() {
  // First check if parent session was passed via environment (for archangels)
  const envUuid = process.env[AX_ARCHANGEL_PARENT_UUID_ENV];
  if (envUuid) {
    // Session name is optional (may be null for non-tmux sessions)
    const envSession = process.env[AX_ARCHANGEL_PARENT_SESSION_ENV] || null;
    return { session: envSession, uuid: envUuid };
  }

  // Fallback to detecting current session (shouldn't be needed for archangels)
  return findCurrentClaudeSession();
}

/**
 * @param {number} [maxEntries]
 * @returns {string}
 */
function getParentSessionContext(maxEntries = 20) {
  const parent = findParentSession();
  if (!parent) return "";

  const logPath = findClaudeLogPath(parent.uuid, parent.session);
  if (!logPath || !existsSync(logPath)) return "";

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Go back further to find meaningful entries (not just tool uses)
    const recent = lines.slice(-maxEntries * 10);
    /** @type {{type: string, text: string}[]} */
    const entries = [];
    /** @type {string | null} */
    let planPath = null;

    for (const line of recent) {
      try {
        const entry = JSON.parse(line);

        // Look for plan file path in the log content
        if (!planPath) {
          const planMatch = line.match(
            /\/Users\/[^"]+\/\.claude\/plans\/[^"]+\.md/
          );
          if (planMatch) planPath = planMatch[0];
        }

        if (entry.type === "user") {
          const c = entry.message?.content;
          // Only include user messages with actual text (not just tool results)
          if (typeof c === "string" && c.length > 10) {
            entries.push({ type: "user", text: c });
          } else if (Array.isArray(c)) {
            const text = c.find(
              /** @param {{type: string, text?: string}} x */ (x) =>
                x.type === "text"
            )?.text;
            if (text && text.length > 10) {
              entries.push({ type: "user", text });
            }
          }
        } else if (entry.type === "assistant") {
          /** @type {{type: string, text?: string}[]} */
          const parts = entry.message?.content || [];
          const text = parts
            .filter((p) => p.type === "text")
            .map((p) => p.text || "")
            .join("\n");
          // Only include assistant responses with meaningful text
          if (text && text.length > 20) {
            entries.push({ type: "assistant", text });
          }
        }
      } catch (err) {
        debugError("getParentSessionContext:parseLine", err);
      }
    }

    // Format recent conversation
    const formatted = entries.slice(-maxEntries).map((e) => {
      const preview = e.text.slice(0, 500).replace(/\n/g, " ");
      return `**${e.type === "user" ? "User" : "Assistant"}**: ${preview}`;
    });

    let result = formatted.join("\n\n");

    // If we found a plan file, include its contents
    if (planPath && existsSync(planPath)) {
      try {
        const planContent = readFileSync(planPath, "utf-8").trim();
        if (planContent) {
          result += "\n\n## Current Plan\n\n" + planContent.slice(0, 2000);
        }
      } catch (err) {
        debugError("getParentSessionContext:readPlan", err);
      }
    }

    return result;
  } catch (err) {
    debugError("getParentSessionContext", err);
    return "";
  }
}

// =============================================================================
// JSONL extraction for intent matching
// =============================================================================

/**
 * @param {string | null} logPath
 * @param {string} filePath
 * @returns {FileEditContext | null}
 */
function extractFileEditContext(logPath, filePath) {
  if (!logPath || !existsSync(logPath)) return null;

  const content = readFileSync(logPath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);

  // Parse all entries
  /** @type {any[]} */
  const entries = lines
    .map((line, idx) => {
      try {
        return { idx, ...JSON.parse(line) };
      } catch (err) {
        debugError("extractFileEditContext:parse", err);
        return null;
      }
    })
    .filter(Boolean);

  // Find Write/Edit tool calls for this file (scan backwards, want most recent)
  /** @type {any} */
  let editEntry = null;
  let editIdx = -1;

  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (entry.type !== "assistant") continue;

    /** @type {any[]} */
    const msgContent = entry.message?.content || [];
    const toolCalls = msgContent.filter(
      (/** @type {any} */ c) =>
        (c.type === "tool_use" || c.type === "tool_call") &&
        (c.name === "Write" || c.name === "Edit")
    );

    for (const tc of toolCalls) {
      const input = tc.input || tc.arguments || {};
      if (
        input.file_path === filePath ||
        input.file_path?.endsWith("/" + filePath)
      ) {
        editEntry = { entry, toolCall: tc, content: msgContent };
        editIdx = i;
        break;
      }
    }
    if (editEntry) break;
  }

  if (!editEntry) return null;

  // Extract intent: text blocks from same assistant message
  const intent = editEntry.content
    .filter((/** @type {any} */ c) => c.type === "text")
    .map((/** @type {any} */ c) => c.text)
    .join("\n")
    .trim();

  // Look forward for Bash errors
  /** @type {string[]} */
  const subsequentErrors = [];
  for (let i = editIdx + 1; i < entries.length && i < editIdx + 10; i++) {
    const entry = entries[i];
    // Check user messages for tool_result with errors
    if (entry.type === "user") {
      /** @type {any[]} */
      const msgContent = entry.message?.content || [];
      if (Array.isArray(msgContent)) {
        for (const c of msgContent) {
          if (c.type === "tool_result" && c.is_error) {
            subsequentErrors.push(c.content?.slice(0, 500) || "error");
          }
        }
      }
    }
  }

  // Look backward for Read calls (what context did agent have?)
  /** @type {string[]} */
  const readsBefore = [];
  for (let i = editIdx - 1; i >= 0 && i > editIdx - 20; i--) {
    const entry = entries[i];
    if (entry.type !== "assistant") continue;

    /** @type {any[]} */
    const msgContent = entry.message?.content || [];
    const readCalls = msgContent.filter(
      (/** @type {any} */ c) =>
        (c.type === "tool_use" || c.type === "tool_call") && c.name === "Read"
    );

    for (const rc of readCalls) {
      const input = rc.input || rc.arguments || {};
      if (input.file_path) readsBefore.push(input.file_path);
    }
  }

  // Count edit sequence (how many times was this file edited?)
  let editSequence = 0;
  for (const entry of entries) {
    if (entry.type !== "assistant") continue;
    /** @type {any[]} */
    const msgContent = entry.message?.content || [];
    const edits = msgContent.filter(
      (/** @type {any} */ c) =>
        (c.type === "tool_use" || c.type === "tool_call") &&
        (c.name === "Write" || c.name === "Edit")
    );
    for (const e of edits) {
      const input = e.input || e.arguments || {};
      if (
        input.file_path === filePath ||
        input.file_path?.endsWith("/" + filePath)
      ) {
        editSequence++;
      }
    }
  }

  return {
    intent,
    toolCall: {
      name: editEntry.toolCall.name,
      input: editEntry.toolCall.input || editEntry.toolCall.arguments,
      id: editEntry.toolCall.id,
    },
    subsequentErrors,
    readsBefore: [...new Set(readsBefore)].slice(0, 10),
    editSequence,
  };
}

// =============================================================================
// Helpers - file watching
// =============================================================================

/**
 * @param {string} pattern
 * @returns {string}
 */
function getBaseDir(pattern) {
  // Extract base directory from glob pattern
  // e.g., "src/**/*.ts" -> "src"
  // e.g., "**/*.ts" -> "."
  const parts = pattern.split("/");
  /** @type {string[]} */
  const baseParts = [];
  for (const part of parts) {
    if (part.includes("*") || part.includes("?") || part.includes("[")) break;
    baseParts.push(part);
  }
  return baseParts.length > 0 ? baseParts.join("/") : ".";
}

/**
 * @param {string} filename
 * @param {string} pattern
 * @returns {boolean}
 */
function matchesPattern(filename, pattern) {
  return path.matchesGlob(filename, pattern);
}

// Default exclusions - always applied
const DEFAULT_EXCLUDE_PATTERNS = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/.next/**",
  "**/coverage/**",
];

/**
 * @param {string[]} patterns
 * @param {(filePath: string) => void} callback
 * @returns {() => void}
 */
function watchForChanges(patterns, callback) {
  // Separate include and exclude patterns
  const includePatterns = patterns.filter((p) => !p.startsWith("!"));
  const userExcludePatterns = patterns
    .filter((p) => p.startsWith("!"))
    .map((p) => p.slice(1));
  const excludePatterns = [...DEFAULT_EXCLUDE_PATTERNS, ...userExcludePatterns];

  /** @type {import('node:fs').FSWatcher[]} */
  const watchers = [];
  /** @type {Set<string>} */
  const watchedDirs = new Set();

  for (const pattern of includePatterns) {
    const dir = getBaseDir(pattern);
    if (watchedDirs.has(dir)) continue;
    if (!existsSync(dir)) continue;

    watchedDirs.add(dir);

    try {
      const watcher = watch(
        dir,
        { recursive: true },
        (_eventType, filename) => {
          if (!filename) return;
          const fullPath = path.join(dir, filename);

          // Check exclusions first
          for (const ex of excludePatterns) {
            if (matchesPattern(fullPath, ex) || matchesPattern(filename, ex)) {
              return; // Excluded
            }
          }

          // Check if this file matches any include pattern
          for (const p of includePatterns) {
            if (matchesPattern(fullPath, p) || matchesPattern(filename, p)) {
              callback(fullPath);
              break;
            }
          }
        }
      );
      watchers.push(watcher);
    } catch (err) {
      console.error(
        `Warning: Failed to watch ${dir}: ${
          err instanceof Error ? err.message : err
        }`
      );
    }
  }

  return () => {
    for (const w of watchers) w.close();
  };
}

// =============================================================================
// State
// =============================================================================

const State = {
  NO_SESSION: "no_session",
  STARTING: "starting",
  UPDATE_PROMPT: "update_prompt",
  READY: "ready",
  THINKING: "thinking",
  CONFIRMING: "confirming",
  RATE_LIMITED: "rate_limited",
  FEEDBACK_MODAL: "feedback_modal",
};

/**
 * Check if the prompt symbol appears with bold styling in the last lines.
 * Used to distinguish actual prompts from text that happens to contain the symbol.
 * @param {string} session - tmux session name
 * @param {string} promptSymbol - The prompt symbol to look for
 * @returns {boolean}
 */
function hasStyledPrompt(session, promptSymbol) {
  const styledScreen = tmuxCapture(session, 0, true); // withEscapes=true

  // If styled capture fails, fall back to allowing READY to avoid deadlock
  if (!styledScreen) {
    debug("state", "styled capture failed, falling back to unstyled check");
    return true;
  }

  // Trim to match detectState behavior (removes trailing blank lines)
  const lines = parseStyledScreenLines(styledScreen.trim());
  const lastLines = lines.slice(-8);

  for (const line of lastLines) {
    for (const span of line.spans) {
      if (span.text.includes(promptSymbol) && span.style?.bold) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Pure function to detect agent state from screen content.
 * @param {string} screen - The screen content to analyze
 * @param {Object} config - Agent configuration for pattern matching
 * @param {string} config.promptSymbol - Symbol indicating ready state
 * @param {string[]} [config.spinners] - Spinner characters indicating thinking
 * @param {RegExp} [config.rateLimitPattern] - Pattern for rate limit detection
 * @param {(string | RegExp | ((lines: string) => boolean))[]} [config.thinkingPatterns] - Text patterns indicating thinking
 * @param {(string | RegExp)[]} [config.activeWorkPatterns] - Patterns indicating active work (beats ready)
 * @param {(string | ((lines: string) => boolean))[]} [config.confirmPatterns] - Patterns for confirmation dialogs
 * @param {{screen: string[], lastLines: string[]} | null} [config.updatePromptPatterns] - Patterns for update prompts
 * @param {string} [config.session] - tmux session for styled prompt verification
 * @param {boolean} [config.requireStyledPrompt] - If true, require prompt to be bold (Codex)
 * @returns {string} The detected state
 */
function detectState(screen, config) {
  if (!screen) {
    debug("state", "no screen -> STARTING");
    return State.STARTING;
  }

  const lines = screen.trim().split("\n");
  const lastLines = lines.slice(-8).join("\n");
  // Larger range for confirmation detection (catches dialogs that scrolled slightly)
  const recentLines = lines.slice(-15).join("\n");

  // Rate limited - check recent lines (not full screen to avoid matching historical output)
  if (config.rateLimitPattern && config.rateLimitPattern.test(recentLines)) {
    debug("state", "rateLimitPattern matched -> RATE_LIMITED");
    return State.RATE_LIMITED;
  }

  // Feedback modal - Claude CLI's "How is Claude doing this session?" prompt
  // Match the numbered options pattern (flexible on whitespace)
  if (
    /1:\s*Bad/i.test(recentLines) &&
    /2:\s*Fine/i.test(recentLines) &&
    /3:\s*Good/i.test(recentLines) &&
    /0:\s*Dismiss/i.test(recentLines)
  ) {
    debug("state", "feedback modal detected -> FEEDBACK_MODAL");
    return State.FEEDBACK_MODAL;
  }

  // Confirming - check before THINKING because "Running…" in tool output matches thinking patterns
  const confirmPatterns = config.confirmPatterns || [];
  for (const pattern of confirmPatterns) {
    if (typeof pattern === "function") {
      // Functions check lastLines first (most specific), then recentLines
      if (pattern(lastLines)) {
        debug(
          "state",
          "confirmPattern function matched lastLines -> CONFIRMING"
        );
        return State.CONFIRMING;
      }
      if (pattern(recentLines)) {
        debug(
          "state",
          "confirmPattern function matched recentLines -> CONFIRMING"
        );
        return State.CONFIRMING;
      }
    } else {
      // String patterns check recentLines (bounded range)
      if (recentLines.includes(pattern)) {
        debug("state", `confirmPattern "${pattern}" matched -> CONFIRMING`);
        return State.CONFIRMING;
      }
    }
  }

  // Check for active work patterns first (agent shows prompt even while working)
  const activeWorkPatterns = config.activeWorkPatterns || [];
  for (const p of activeWorkPatterns) {
    const matched =
      p instanceof RegExp ? p.test(lastLines) : lastLines.includes(p);
    if (matched) {
      debug("state", `activeWorkPattern "${p}" matched -> THINKING`);
      return State.THINKING;
    }
  }

  // Ready - check BEFORE thinking to avoid false positives from timing messages like "✻ Worked for 45s"
  // If the prompt symbol is visible, the agent is ready regardless of spinner characters in timing messages
  if (lastLines.includes(config.promptSymbol)) {
    // If styled prompt check is enabled, verify prompt has expected styling
    // This prevents false positives from output containing the prompt symbol
    if (config.requireStyledPrompt && config.session) {
      if (hasStyledPrompt(config.session, config.promptSymbol)) {
        debug(
          "state",
          `promptSymbol "${config.promptSymbol}" found with bold styling -> READY`
        );
        return State.READY;
      }
      debug(
        "state",
        `promptSymbol "${config.promptSymbol}" found but not bold, continuing checks`
      );
    } else {
      debug("state", `promptSymbol "${config.promptSymbol}" found -> READY`);
      return State.READY;
    }
  }

  // Thinking - spinners (check last lines only)
  const spinners = config.spinners || [];
  for (const s of spinners) {
    if (lastLines.includes(s)) {
      debug("state", `spinner "${s}" matched -> THINKING`);
      return State.THINKING;
    }
  }
  // Thinking - text patterns (last lines) - supports strings, regexes, and functions
  const thinkingPatterns = config.thinkingPatterns || [];
  for (const p of thinkingPatterns) {
    let matched = false;
    if (typeof p === "function") matched = p(lastLines);
    else if (p instanceof RegExp) matched = p.test(lastLines);
    else matched = lastLines.includes(p);
    if (matched) {
      debug("state", `thinkingPattern "${p}" matched -> THINKING`);
      return State.THINKING;
    }
  }

  // Update prompt
  if (config.updatePromptPatterns) {
    const { screen: sp, lastLines: lp } = config.updatePromptPatterns;
    if (
      sp &&
      sp.some((p) => screen.includes(p)) &&
      lp &&
      lp.some((p) => lastLines.includes(p))
    ) {
      debug("state", "updatePromptPatterns matched -> UPDATE_PROMPT");
      return State.UPDATE_PROMPT;
    }
  }

  debug("state", "no patterns matched -> STARTING");
  debug("state", `lastLines:\n${lastLines}`);
  debug("state", `recentLines:\n${recentLines}`);
  return State.STARTING;
}

// =============================================================================
// Agent base class
// =============================================================================

/**
 * @typedef {string | ((lines: string) => boolean)} ConfirmPattern
 */

/**
 * @typedef {Object} UpdatePromptPatterns
 * @property {string[]} screen
 * @property {string[]} lastLines
 */

/**
 * @typedef {Object} AgentConfigInput
 * @property {string} name
 * @property {string} displayName
 * @property {string} startCommand
 * @property {string} yoloCommand
 * @property {string} promptSymbol
 * @property {string[]} [spinners]
 * @property {RegExp} [rateLimitPattern]
 * @property {(string | RegExp | ((lines: string) => boolean))[]} [thinkingPatterns]
 * @property {(string | RegExp)[]} [activeWorkPatterns]
 * @property {ConfirmPattern[]} [confirmPatterns]
 * @property {UpdatePromptPatterns | null} [updatePromptPatterns]
 * @property {string[]} [responseMarkers]
 * @property {string[]} [chromePatterns]
 * @property {Record<string, string> | null} [reviewOptions]
 * @property {string} envVar
 * @property {string} [approveKey]
 * @property {string} [rejectKey]
 * @property {string} [safeAllowedTools]
 * @property {string | null} [sessionIdFlag]
 * @property {((sessionName: string) => string | null) | null} [logPathFinder]
 * @property {boolean} [requireStyledPrompt] - If true, require prompt to be bold for READY detection
 */

class Agent {
  /**
   * @param {AgentConfigInput} config
   */
  constructor(config) {
    /** @type {string} */
    this.name = config.name;
    /** @type {string} */
    this.displayName = config.displayName;
    /** @type {string} */
    this.startCommand = config.startCommand;
    /** @type {string} */
    this.yoloCommand = config.yoloCommand;
    /** @type {string} */
    this.promptSymbol = config.promptSymbol;
    /** @type {string[]} */
    this.spinners = config.spinners || [];
    /** @type {RegExp | undefined} */
    this.rateLimitPattern = config.rateLimitPattern;
    /** @type {(string | RegExp | ((lines: string) => boolean))[]} */
    this.thinkingPatterns = config.thinkingPatterns || [];
    /** @type {(string | RegExp)[]} */
    this.activeWorkPatterns = config.activeWorkPatterns || [];
    /** @type {ConfirmPattern[]} */
    this.confirmPatterns = config.confirmPatterns || [];
    /** @type {UpdatePromptPatterns | null} */
    this.updatePromptPatterns = config.updatePromptPatterns || null;
    /** @type {string[]} */
    this.responseMarkers = config.responseMarkers || [];
    /** @type {string[]} */
    this.chromePatterns = config.chromePatterns || [];
    /** @type {Record<string, string> | null | undefined} */
    this.reviewOptions = config.reviewOptions ?? null;
    /** @type {string} */
    this.envVar = config.envVar;
    /** @type {string} */
    this.approveKey = config.approveKey || "y";
    /** @type {string} */
    this.rejectKey = config.rejectKey || "n";
    /** @type {string | undefined} */
    this.safeAllowedTools = config.safeAllowedTools;
    /** @type {string | null} */
    this.sessionIdFlag = config.sessionIdFlag || null;
    /** @type {((sessionName: string) => string | null) | null} */
    this.logPathFinder = config.logPathFinder || null;
    /** @type {boolean} */
    this.requireStyledPrompt = config.requireStyledPrompt || false;
  }

  /**
   * @param {boolean} [yolo]
   * @param {string | null} [sessionName]
   * @param {string | null} [customAllowedTools]
   * @returns {string}
   */
  getCommand(yolo, sessionName = null, customAllowedTools = null) {
    let base;
    if (yolo) {
      base = this.yoloCommand;
      debug("command", `mode=yolo`);
    } else if (customAllowedTools) {
      // Custom permissions from --auto-approve flag
      // Escape for shell: backslashes first, then double quotes
      const escaped = customAllowedTools
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"');
      base = `${this.startCommand} --allowedTools "${escaped}"`;
      debug("command", `mode=custom, allowedTools=${customAllowedTools}`);
    } else if (this.safeAllowedTools) {
      // Default: auto-approve safe read-only operations
      base = `${this.startCommand} --allowedTools "${this.safeAllowedTools}"`;
      debug("command", `mode=safe, allowedTools=${this.safeAllowedTools}`);
    } else {
      base = this.startCommand;
      debug("command", `mode=default`);
    }
    // Some agents support session ID flags for deterministic session tracking
    if (this.sessionIdFlag && sessionName) {
      const parsed = parseSessionName(sessionName);
      if (parsed?.uuid) {
        const cmd = `${base} ${this.sessionIdFlag} ${parsed.uuid}`;
        debug("command", `full: ${cmd}`);
        return cmd;
      }
    }
    debug("command", `full: ${base}`);
    return base;
  }

  /**
   * @param {{allowedTools?: string | null, yolo?: boolean}} [options]
   * @returns {string | null}
   */
  getDefaultSession({ allowedTools = null, yolo = false } = {}) {
    // Check env var for explicit session
    if (this.envVar && process.env[this.envVar]) {
      return process.env[this.envVar] ?? null;
    }

    const cwd = process.cwd();
    // Match sessions: {tool}-(partner-)?{uuid}[-p{hash}|-yolo]?
    const childPattern = new RegExp(
      `^${this.name}-(partner-)?${UUID_PATTERN}(-p${PERM_HASH_PATTERN}|-yolo)?$`,
      "i"
    );
    const requestedHash = computePermissionHash(allowedTools);

    /**
     * Find a matching session by walking up the directory tree.
     * Checks exact cwd first, then parent directories up to git root or home.
     * @param {string[]} sessions
     * @returns {string | null}
     */
    const findSessionInCwdOrParent = (sessions) => {
      const matchingSessions = sessions.filter((s) => {
        if (!childPattern.test(s)) return false;

        const perms = getSessionPermissions(s);

        // If yolo requested, only match yolo sessions
        if (yolo) {
          return perms.mode === "yolo";
        }

        // If custom permissions requested, match yolo (superset) or same hash
        if (requestedHash) {
          return perms.mode === "yolo" || perms.hash === requestedHash;
        }

        // If no special permissions, match safe sessions only
        return perms.mode === "safe";
      });
      if (matchingSessions.length === 0) return null;

      // Cache session cwds to avoid repeated tmux calls
      const sessionCwds = new Map(
        matchingSessions.map((s) => [s, getTmuxSessionCwd(s)])
      );

      let searchDir = cwd;
      const homeDir = os.homedir();

      while (searchDir !== homeDir && searchDir !== "/") {
        const existing = matchingSessions.find(
          (s) => sessionCwds.get(s) === searchDir
        );
        if (existing) return existing;

        // Stop at git root (don't leak across projects)
        if (existsSync(path.join(searchDir, ".git"))) break;

        searchDir = path.dirname(searchDir);
      }

      return null;
    };

    // If inside tmux, look for existing agent session in cwd or parent
    const current = tmuxCurrentSession();
    if (current) {
      const sessions = tmuxListSessions();
      const existing = findSessionInCwdOrParent(sessions);
      if (existing) return existing;
      // No existing session in this cwd or parent - will generate new one in cmdStart
      return null;
    }

    // Walk up to find claude/codex ancestor and reuse its session
    const caller = findCallerAgent();
    if (caller) {
      const sessions = tmuxListSessions();
      const existing = findSessionInCwdOrParent(sessions);
      if (existing) return existing;
    }

    // No existing session found
    return null;
  }

  /**
   * @param {{allowedTools?: string | null, yolo?: boolean}} [options]
   * @returns {string}
   */
  generateSession(options = {}) {
    return generateSessionName(this.name, options);
  }

  /**
   * Find the log file path for a session.
   * @param {string} sessionName
   * @returns {string | null}
   */
  findLogPath(sessionName) {
    if (this.logPathFinder) {
      return this.logPathFinder(sessionName);
    }
    return null;
  }

  /**
   * Create a terminal stream for reading agent output.
   * Returns JsonlTerminalStream for agents with log file support,
   * otherwise falls back to ScreenTerminalStream.
   * @param {string} sessionName
   * @param {{skipExisting?: boolean}} [opts] - Options
   * @returns {TerminalStream}
   */
  createStream(sessionName, opts = {}) {
    // Prefer JSONL stream if agent has log path finder
    if (this.logPathFinder) {
      /** @type {'claude' | 'codex'} */
      const format = this.name === "claude" ? "claude" : "codex";
      return new JsonlTerminalStream(
        () => this.findLogPath(sessionName),
        format,
        opts
      );
    }
    // Fall back to screen capture
    return new ScreenTerminalStream(sessionName);
  }

  /**
   * Create a styled terminal stream with ANSI color support.
   * Only uses screen capture (JSONL doesn't have style info).
   * @param {string} sessionName
   * @param {number} [scrollback]
   * @returns {StyledScreenTerminalStream}
   */
  createStyledStream(sessionName, scrollback = 0) {
    return new StyledScreenTerminalStream(sessionName, scrollback);
  }

  /**
   * @param {string} screen
   * @param {string} [session] - Optional session for styled prompt verification
   * @returns {string}
   */
  getState(screen, session) {
    return detectState(screen, {
      promptSymbol: this.promptSymbol,
      spinners: this.spinners,
      rateLimitPattern: this.rateLimitPattern,
      thinkingPatterns: this.thinkingPatterns,
      activeWorkPatterns: this.activeWorkPatterns,
      confirmPatterns: this.confirmPatterns,
      updatePromptPatterns: this.updatePromptPatterns,
      session,
      requireStyledPrompt: this.requireStyledPrompt,
    });
  }

  /**
   * @param {string} screen
   * @returns {string}
   */
  parseRetryTime(screen) {
    const match = screen.match(/try again at ([0-9]{1,2}:[0-9]{2}\s*[AP]M)/i);
    return match ? match[1] : "unknown";
  }

  /**
   * @param {string} screen
   * @returns {string}
   */
  parseAction(screen) {
    /** @param {string} s */
    // eslint-disable-next-line no-control-regex
    const clean = (s) => s.replace(/\x1b\[[0-9;]*m/g, "").trim();
    const lines = screen.split("\n").map(clean);

    for (const line of lines) {
      if (line.startsWith("$") || line.startsWith(">")) return line;
      if (/^(run|execute|create|delete|modify|write)/i.test(line)) return line;
    }

    return (
      lines
        .filter((l) => l && !l.match(/^[╭╮╰╯│─]+$/))
        .slice(0, 2)
        .join(" | ") || "action"
    );
  }

  /**
   * @param {string} line
   * @returns {boolean}
   */
  isChromeLine(line) {
    const trimmed = line.trim();
    if (!trimmed) return true;
    // Box drawing characters only
    if (/^[╭╮╰╯│─┌┐└┘├┤┬┴┼\s]+$/.test(line)) return true;
    // Horizontal separators
    if (/^─{3,}$/.test(trimmed)) return true;
    // Status bar indicators (shortcuts help, connection status)
    if (/^\s*[?⧉◯●]\s/.test(line)) return true;
    // Logo/branding characters (block drawing)
    if (/[▐▛▜▌▝▘█▀▄]/.test(trimmed) && trimmed.length < 50) return true;
    // Version strings, model info
    if (
      /^(Claude Code|OpenAI Codex|Opus|gpt-|model:|directory:|cwd:)/i.test(
        trimmed
      )
    )
      return true;
    // Path-only lines (working directory display)
    if (/^~\/[^\s]*$/.test(trimmed)) return true;
    // Explicit chrome patterns from agent config
    if (this.chromePatterns.some((p) => trimmed.includes(p))) return true;
    return false;
  }

  /**
   * @param {string} screen
   * @returns {string[]}
   */
  extractResponses(screen) {
    // eslint-disable-next-line no-control-regex
    const clean = screen.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r/g, "");
    const lines = clean.split("\n");
    /** @type {string[]} */
    const responses = [];
    /** @type {string[]} */
    let current = [];
    let inResponse = false;

    for (const line of lines) {
      // Skip chrome lines
      if (this.isChromeLine(line)) continue;

      // User prompt marks end of previous response
      if (line.startsWith(this.promptSymbol)) {
        if (current.length) {
          responses.push(current.join("\n").trim());
          current = [];
        }
        inResponse = false;
        continue;
      }

      // Response markers
      const isMarker = this.responseMarkers.some((m) => line.startsWith(m));
      if (isMarker) {
        if (!inResponse && current.length) {
          responses.push(current.join("\n").trim());
          current = [];
        }
        inResponse = true;
        current.push(line);
      } else if (inResponse && (line.startsWith("  ") || line.trim() === "")) {
        current.push(line);
      } else if (inResponse && line.trim()) {
        current.push(line);
      }
    }
    if (current.length) responses.push(current.join("\n").trim());

    const filtered = responses.filter((r) => r.length > 0);

    // Fallback: extract after last prompt
    if (filtered.length === 0) {
      const lastPromptIdx = lines.findLastIndex((/** @type {string} */ l) =>
        l.startsWith(this.promptSymbol)
      );
      if (lastPromptIdx >= 0 && lastPromptIdx < lines.length - 1) {
        const afterPrompt = lines
          .slice(lastPromptIdx + 1)
          .filter((/** @type {string} */ l) => !this.isChromeLine(l))
          .join("\n")
          .trim();
        if (afterPrompt) return [afterPrompt];
      }

      // Second fallback: if the last prompt is empty (just ❯), look BEFORE it
      // This handles the case where Claude finished and shows a new empty prompt
      if (lastPromptIdx >= 0) {
        const lastPromptLine = lines[lastPromptIdx];
        const isEmptyPrompt =
          lastPromptLine.trim() === this.promptSymbol ||
          lastPromptLine.match(/^❯\s*$/);
        if (isEmptyPrompt) {
          // Find the previous prompt (user's input) and extract content between
          // Note: [Pasted text is Claude's truncated output indicator, NOT a prompt
          const prevPromptIdx = lines
            .slice(0, lastPromptIdx)
            .findLastIndex((/** @type {string} */ l) =>
              l.startsWith(this.promptSymbol)
            );
          if (prevPromptIdx >= 0) {
            const betweenPrompts = lines
              .slice(prevPromptIdx + 1, lastPromptIdx)
              .filter((/** @type {string} */ l) => !this.isChromeLine(l))
              .join("\n")
              .trim();
            if (betweenPrompts) return [betweenPrompts];
          }
        }
      }
    }

    return filtered;
  }

  /**
   * @param {string} response
   * @returns {string}
   */
  cleanResponse(response) {
    return (
      response
        // Remove tool call lines (Search, Read, Grep, etc.)
        .replace(
          /^[⏺•]\s*(Search|Read|Grep|Glob|Write|Edit|Bash)\([^)]*\).*$/gm,
          ""
        )
        // Remove tool result lines
        .replace(/^⎿\s+.*$/gm, "")
        // Remove "Sautéed for Xs" timing lines
        .replace(/^✻\s+Sautéed for.*$/gm, "")
        // Remove expand hints
        .replace(/\(ctrl\+o to expand\)/g, "")
        // Clean up multiple blank lines
        .replace(/\n{3,}/g, "\n\n")
        // Original cleanup
        .replace(/^[•⏺-]\s*/, "")
        .replace(/^\*\*(.+)\*\*/, "$1")
        .replace(/\n  /g, "\n")
        .replace(/─+\s*$/, "")
        .trim()
    );
  }

  /**
   * Get assistant response text, preferring JSONL log over screen scraping.
   * @param {string} session - tmux session name
   * @param {string} screen - captured screen content (fallback)
   * @param {number} [index=0] - 0 = last response, -1 = second-to-last, etc.
   * @returns {string | null}
   */
  getResponse(session, screen, index = 0) {
    // Try JSONL first (clean, no screen artifacts)
    const logPath = this.findLogPath(session);
    const jsonlText = logPath ? getAssistantText(logPath, index) : null;
    if (jsonlText) return jsonlText;

    // Fallback to screen scraping
    const responses = this.extractResponses(screen);
    const i = responses.length - 1 + index;
    const response = responses[i];
    return response ? this.cleanResponse(response) : null;
  }

  /**
   * @param {string} session
   */
  async handleUpdatePrompt(session) {
    // Default: skip update (send "2" then Enter)
    tmuxSend(session, "2");
    await sleep(300);
    tmuxSend(session, "Enter");
    await sleep(500);
  }
}

// =============================================================================
// CodexAgent
// =============================================================================

const CodexAgent = new Agent({
  name: "codex",
  displayName: "Codex",
  startCommand: "codex --sandbox read-only",
  yoloCommand: "codex --dangerously-bypass-approvals-and-sandbox",
  promptSymbol: "›",
  spinners: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  rateLimitPattern: /■.*(?:usage limit|rate limit|try again at)/i,
  thinkingPatterns: ["Thinking…", "Thinking..."],
  confirmPatterns: [
    (lines) => lines.includes("[y]") && lines.includes("[n]"),
    "Run command?",
    (lines) => lines.includes("Allow") && lines.includes("Deny"),
  ],
  updatePromptPatterns: {
    screen: ["Update available"],
    lastLines: ["Skip"],
  },
  activeWorkPatterns: ["esc to interrupt"],
  responseMarkers: ["•", "- ", "**"],
  chromePatterns: ["context left", "for shortcuts"],
  reviewOptions: { branch: "1", uncommitted: "2", commit: "3", custom: "4" },
  envVar: "AX_SESSION",
  logPathFinder: findCodexLogPath,
  requireStyledPrompt: true, // Codex prompt is bold, use this to avoid false positives
});

// =============================================================================
// ClaudeAgent
// =============================================================================

const ClaudeAgent = new Agent({
  name: "claude",
  displayName: "Claude",
  startCommand: "claude",
  yoloCommand: "claude --dangerously-skip-permissions",
  promptSymbol: "❯",
  // Claude Code spinners: ·✢✳✶✻✽ (from cli.js source)
  spinners: ["·", "✢", "✳", "✶", "✻", "✽"],
  rateLimitPattern: /rate.?limit/i,
  // Claude uses whimsical verbs like "Wibbling…", "Dancing…", etc. Match any capitalized -ing word + ellipsis (… or ...)
  thinkingPatterns: ["Thinking", /[A-Z][a-z]+ing(…|\.\.\.)/],
  activeWorkPatterns: ["esc to interrupt"],
  confirmPatterns: [
    "Do you want to make this edit",
    "Do you want to run this command",
    "Do you want to proceed",
    // Active menu: numbered options with Yes/No/Allow/Deny
    (lines) => /\d+\.\s*(Yes|No|Allow|Deny)/i.test(lines),
  ],
  updatePromptPatterns: null,
  responseMarkers: ["⏺", "•", "- ", "**"],
  chromePatterns: [
    "↵ send",
    "Esc to cancel",
    "shortcuts",
    "for more options",
    "docs.anthropic.com",
    "⏵⏵",
    "bypass permissions",
    "shift+Tab to cycle",
  ],
  reviewOptions: null,
  safeAllowedTools: "Bash(git:*) Read Glob Grep", // Default: auto-approve read-only tools
  envVar: "AX_SESSION",
  approveKey: "1",
  rejectKey: "Escape",
  sessionIdFlag: "--session-id",
  logPathFinder: (sessionName) => {
    const parsed = parseSessionName(sessionName);
    const uuid = parsed?.uuid;
    if (uuid) return findClaudeLogPath(uuid, sessionName);
    return null;
  },
});

// =============================================================================
// Commands
// =============================================================================

/**
 * Wait until agent reaches a terminal state (ready, confirming, or rate limited).
 * Returns immediately if already in a terminal state.
 * @param {Agent} agent
 * @param {string} session
 * @param {number} [timeoutMs]
 * @returns {Promise<{state: string, screen: string}>}
 */
async function waitUntilReady(agent, session, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  const initialScreen = tmuxCapture(session);
  const initialState = agent.getState(initialScreen, session);
  debug(
    "waitUntilReady",
    `start: initialState=${initialState}, timeout=${timeoutMs}ms`
  );

  // Dismiss feedback modal if present
  if (initialState === State.FEEDBACK_MODAL) {
    debug("waitUntilReady", `dismissing feedback modal`);
    tmuxSend(session, "0");
    await sleep(200);
  } else if (
    // Already in terminal state
    initialState === State.RATE_LIMITED ||
    initialState === State.CONFIRMING ||
    initialState === State.READY
  ) {
    debug("waitUntilReady", `already in terminal state: ${initialState}`);
    return { state: initialState, screen: initialScreen };
  }

  while (Date.now() - start < timeoutMs) {
    await sleep(POLL_MS);
    const screen = tmuxCapture(session);
    const state = agent.getState(screen, session);

    // Dismiss feedback modal if it appears
    if (state === State.FEEDBACK_MODAL) {
      debug("waitUntilReady", `dismissing feedback modal`);
      tmuxSend(session, "0");
      await sleep(200);
      continue;
    }

    if (
      state === State.RATE_LIMITED ||
      state === State.CONFIRMING ||
      state === State.READY
    ) {
      debug(
        "waitUntilReady",
        `reached state=${state} after ${Date.now() - start}ms`
      );
      return { state, screen };
    }
  }
  debug("waitUntilReady", `timeout after ${timeoutMs}ms`);
  throw new TimeoutError(session);
}

/**
 * Core polling loop for waiting on agent responses.
 * @param {Agent} agent
 * @param {string} session
 * @param {number} timeoutMs
 * @param {{onPoll?: (screen: string, state: string) => void, onStateChange?: (state: string, lastState: string | null, screen: string) => void, onReady?: (screen: string) => void}} [hooks]
 * @returns {Promise<{state: string, screen: string}>}
 */
async function pollForResponse(agent, session, timeoutMs, hooks = {}) {
  const { onPoll, onStateChange, onReady } = hooks;
  const start = Date.now();
  const initialScreen = tmuxCapture(session);
  const initialState = agent.getState(initialScreen, session);
  debug("poll", `start: initialState=${initialState}, timeoutMs=${timeoutMs}`);

  let lastScreen = initialScreen;
  let lastState = null;
  let stableAt = null;
  let sawActivity = false;
  let sawThinking = false;

  // Fallback timeout: accept READY without sawThinking after this many ms
  // This handles fast responses where we might miss the THINKING state
  // Clamp to timeoutMs so short timeouts don't always fail
  const THINKING_FALLBACK_MS = Math.min(10000, timeoutMs);

  while (Date.now() - start < timeoutMs) {
    const screen = tmuxCapture(session);
    const state = agent.getState(screen, session);

    if (onPoll) onPoll(screen, state);

    if (state !== lastState) {
      if (onStateChange) onStateChange(state, lastState, screen);
      lastState = state;
    }

    if (state === State.RATE_LIMITED || state === State.CONFIRMING) {
      return { state, screen };
    }

    // Dismiss feedback modal if it appears
    if (state === State.FEEDBACK_MODAL) {
      tmuxSend(session, "0");
      await sleep(200);
      continue;
    }

    if (screen !== lastScreen) {
      lastScreen = screen;
      stableAt = Date.now();
      if (screen !== initialScreen) {
        if (!sawActivity)
          debug("poll", "sawActivity=true (screen changed from initial)");
        sawActivity = true;
      }
    }

    // Check if we can return READY
    if (sawActivity && stableAt && Date.now() - stableAt >= STABLE_MS) {
      if (state === State.READY) {
        // Require sawThinking OR enough time has passed (fallback for fast responses)
        const elapsed = Date.now() - start;
        if (sawThinking || elapsed >= THINKING_FALLBACK_MS) {
          debug(
            "poll",
            `returning READY after ${elapsed}ms (sawThinking=${sawThinking})`
          );
          if (onReady) onReady(screen);
          return { state, screen };
        }
      }
    }

    if (state === State.THINKING) {
      sawActivity = true;
      if (!sawThinking) debug("poll", "sawThinking=true");
      sawThinking = true;
    }

    await sleep(POLL_MS);
  }
  throw new TimeoutError(session);
}

/**
 * Wait for agent response without streaming output.
 * @param {Agent} agent
 * @param {string} session
 * @param {number} [timeoutMs]
 * @returns {Promise<{state: string, screen: string}>}
 */
async function waitForResponse(agent, session, timeoutMs = DEFAULT_TIMEOUT_MS) {
  return pollForResponse(agent, session, timeoutMs);
}

/**
 * Wait for agent response with streaming output to console.
 * Uses TerminalStream abstraction for reading agent output.
 * @param {Agent} agent
 * @param {string} session
 * @param {number} [timeoutMs]
 * @returns {Promise<{state: string, screen: string}>}
 */
async function streamResponse(agent, session, timeoutMs = DEFAULT_TIMEOUT_MS) {
  // Create terminal stream for this agent/session
  // Skip existing content - only stream new responses
  const stream = agent.createStream(session, { skipExisting: true });
  let printedThinking = false;
  debug("stream", `start: using ${stream.constructor.name}`);

  // Sliding window for deduplication - only dedupe recent messages
  // This catches Codex's duplicate log entries (A,B,A,B pattern) while
  // allowing legitimate repeated messages across turns
  /** @type {string[]} */
  const recentMessages = [];
  const DEDUPE_WINDOW = 10;

  const streamNewLines = async () => {
    const lines = await stream.readNext();
    if (lines.length > 0) {
      debug("stream", `read ${lines.length} lines`);
    }

    for (const line of lines) {
      const text = line.raw;
      if (!text) continue;

      // Dedupe messages within sliding window (Codex logs can contain duplicates)
      // Tool calls are exempt: lineType === "tool" for JSONL streams, or starts with ">" for screen streams
      const isToolLine =
        line.lineType === "tool" || (!line.lineType && text.startsWith(">"));
      if (!isToolLine) {
        if (recentMessages.includes(text)) continue;
        recentMessages.push(text);
        if (recentMessages.length > DEDUPE_WINDOW) recentMessages.shift();
      }

      // Style based on content type
      // For screen streams, tool lines start with ">" and should be dimmed
      const isThinking = line.lineType === "thinking";
      const styled = isToolLine || isThinking ? styleText("dim", text) : text;
      console.log(styled);
    }
  };

  return pollForResponse(agent, session, timeoutMs, {
    onPoll: () => streamNewLines(),
    onStateChange: (state, lastState, screen) => {
      if (state === State.THINKING && !printedThinking) {
        console.log(styleText("dim", "[THINKING]"));
        printedThinking = true;
      } else if (state === State.CONFIRMING) {
        const pendingTool = extractPendingToolFromScreen(screen);
        console.log(
          styleText(
            "yellow",
            pendingTool ? `[CONFIRMING] ${pendingTool}` : "[CONFIRMING]"
          )
        );
      }
      if (lastState === State.THINKING && state !== State.THINKING) {
        printedThinking = false;
      }
    },
    onReady: () => streamNewLines(),
  });
}

/**
 * Auto-approve loop that keeps approving confirmations until the agent is ready or rate limited.
 * @param {Agent} agent
 * @param {string} session
 * @param {number} timeoutMs
 * @param {Function} waitFn - waitForResponse or streamResponse
 * @returns {Promise<{state: string, screen: string}>}
 */
async function autoApproveLoop(agent, session, timeoutMs, waitFn) {
  const deadline = Date.now() + timeoutMs;
  debug("autoApprove", `starting loop, timeout=${timeoutMs}ms`);

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const { state, screen } = await waitFn(agent, session, remaining);

    if (state === State.RATE_LIMITED || state === State.READY) {
      debug("autoApprove", `finished with state=${state}`);
      return { state, screen };
    }

    if (state === State.CONFIRMING) {
      debug("autoApprove", `auto-approving confirmation`);
      tmuxSend(session, agent.approveKey);
      await sleep(APPROVE_DELAY_MS);
      continue;
    }

    // FEEDBACK_MODAL is handled by the underlying waitFn (pollForResponse)
    debugError("autoApproveLoop", new Error(`unexpected state: ${state}`));
  }

  debug("autoApprove", `timeout`);
  throw new TimeoutError(session);
}

/**
 * @param {Agent} agent
 * @param {string | null | undefined} session
 * @param {Object} [options]
 * @param {boolean} [options.yolo]
 * @param {string | null} [options.allowedTools]
 * @returns {Promise<string>}
 */
async function cmdStart(
  agent,
  session,
  { yolo = false, allowedTools = null } = {}
) {
  // Generate session name if not provided
  if (!session) {
    session = agent.generateSession({ allowedTools, yolo });
    debug("session", `generated new session: ${session}`);
  }

  if (tmuxHasSession(session)) {
    debug("session", `reusing existing session: ${session}`);
    return session;
  }

  // Check agent CLI is installed before trying to start
  const cliCheck = spawnSync("which", [agent.name], { encoding: "utf-8" });
  if (cliCheck.status !== 0) {
    console.error(`ERROR: ${agent.name} CLI is not installed or not in PATH`);
    process.exit(1);
  }

  const command = agent.getCommand(yolo, session, allowedTools);
  debug("session", `creating tmux session: ${session}`);
  tmuxNewSession(session, command);

  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    const screen = tmuxCapture(session);
    const state = agent.getState(screen, session);

    if (state === State.UPDATE_PROMPT) {
      await agent.handleUpdatePrompt(session);
      continue;
    }

    if (state === State.FEEDBACK_MODAL) {
      tmuxSend(session, "0");
      await sleep(200);
      continue;
    }

    if (state === State.CONFIRMING) {
      tmuxSend(session, agent.approveKey);
      await sleep(APPROVE_DELAY_MS);
      continue;
    }

    if (state === State.READY) return session;

    await sleep(POLL_MS);
  }

  console.log("ERROR: timeout");
  process.exit(1);
}

// =============================================================================
// Command: agents
// =============================================================================

function cmdAgents() {
  const allSessions = tmuxListSessions();

  // Filter to agent sessions (claude-uuid or codex-uuid format)
  const agentSessions = allSessions.filter((s) => parseSessionName(s));

  if (agentSessions.length === 0) {
    console.log("No agents running");
    // Still check for orphans
    const orphans = findOrphanedProcesses();
    if (orphans.length > 0) {
      console.log(`\nOrphaned (${orphans.length}):`);
      for (const { pid, command } of orphans) {
        console.log(`  PID ${pid}: ${command}`);
      }
      console.log(`\n  Run 'ax kill --orphans' to clean up`);
    }
    return;
  }

  // Get default session for each agent type
  const claudeDefault = ClaudeAgent.getDefaultSession();
  const codexDefault = CodexAgent.getDefaultSession();

  // Get info for each agent
  const agents = agentSessions.map((session) => {
    const parsed = /** @type {ParsedSession} */ (parseSessionName(session));
    const agent = parsed.tool === "claude" ? ClaudeAgent : CodexAgent;
    const screen = tmuxCapture(session);
    const state = agent.getState(screen, session);
    const type = parsed.archangelName ? "archangel" : "-";
    const isDefault =
      (parsed.tool === "claude" && session === claudeDefault) ||
      (parsed.tool === "codex" && session === codexDefault);
    const perms = getSessionPermissions(session);

    // Get session metadata (Claude only)
    const meta = getSessionMeta(session);

    return {
      session,
      tool: parsed.tool,
      state: state || "unknown",
      target: isDefault ? "*" : "",
      type,
      mode: perms.mode,
      plan: meta?.slug || "-",
      branch: meta?.gitBranch || "-",
    };
  });

  // Print sessions table
  const maxSession = Math.max(7, ...agents.map((a) => a.session.length));
  const maxTool = Math.max(4, ...agents.map((a) => a.tool.length));
  const maxState = Math.max(5, ...agents.map((a) => a.state.length));
  const maxTarget = Math.max(6, ...agents.map((a) => a.target.length));
  const maxType = Math.max(4, ...agents.map((a) => a.type.length));
  const maxMode = Math.max(4, ...agents.map((a) => a.mode.length));
  const maxPlan = Math.max(4, ...agents.map((a) => a.plan.length));

  console.log(
    `${"SESSION".padEnd(maxSession)}  ${"TOOL".padEnd(
      maxTool
    )}  ${"STATE".padEnd(maxState)}  ${"TARGET".padEnd(
      maxTarget
    )}  ${"TYPE".padEnd(maxType)}  ${"MODE".padEnd(maxMode)}  ${"PLAN".padEnd(
      maxPlan
    )}  BRANCH`
  );
  for (const a of agents) {
    console.log(
      `${a.session.padEnd(maxSession)}  ${a.tool.padEnd(
        maxTool
      )}  ${a.state.padEnd(maxState)}  ${a.target.padEnd(
        maxTarget
      )}  ${a.type.padEnd(maxType)}  ${a.mode.padEnd(maxMode)}  ${a.plan.padEnd(
        maxPlan
      )}  ${a.branch}`
    );
  }

  // Print orphaned processes if any
  const orphans = findOrphanedProcesses();
  if (orphans.length > 0) {
    console.log(`\nOrphaned (${orphans.length}):`);
    for (const { pid, command } of orphans) {
      console.log(`  PID ${pid}: ${command}`);
    }
    console.log(`\n  Run 'ax kill --orphans' to clean up`);
  }
}

// =============================================================================
// Command: summon/recall
// =============================================================================

/**
 * @param {string} pattern
 * @returns {string | undefined}
 */
function findArchangelSession(pattern) {
  const sessions = tmuxListSessions();
  return sessions.find((s) => s.startsWith(pattern));
}

/**
 * @param {ArchangelConfig} config
 * @returns {string}
 */
function generateArchangelSessionName(config) {
  return `${config.tool}-archangel-${config.name}-${randomUUID()}`;
}

/**
 * @param {ArchangelConfig} config
 * @param {ParentSession | null} [parentSession]
 */
function startArchangel(config, parentSession = null) {
  /** @type {NodeJS.ProcessEnv} */
  const env = { ...process.env };
  if (parentSession?.uuid) {
    if (parentSession.session) {
      env[AX_ARCHANGEL_PARENT_SESSION_ENV] = parentSession.session;
    }
    env[AX_ARCHANGEL_PARENT_UUID_ENV] = parentSession.uuid;
  }

  const child = spawn("node", [process.argv[1], "archangel", config.name], {
    detached: true,
    stdio: "ignore",
    cwd: process.cwd(),
    env,
  });
  child.unref();
  const watchingLabel = parentSession
    ? parentSession.session || parentSession.uuid?.slice(0, 8)
    : null;
  console.log(
    `Summoning: ${config.name} (pid ${child.pid})${
      watchingLabel ? ` [watching: ${watchingLabel}]` : ""
    }`
  );
}

/**
 * @param {string} pattern
 * @param {number} [timeoutMs]
 * @returns {Promise<string | undefined>}
 */
async function waitForArchangelSession(
  pattern,
  timeoutMs = ARCHANGEL_STARTUP_TIMEOUT_MS
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const session = findArchangelSession(pattern);
    if (session) return session;
    await sleep(200);
  }
  return undefined;
}

// =============================================================================
// Command: archangel (runs as the archangel process itself)
// =============================================================================

/**
 * @param {string | undefined} agentName
 */
async function cmdArchangel(agentName) {
  if (!agentName) {
    console.error("Usage: ./ax.js archangel <name>");
    process.exit(1);
  }
  // Load agent config
  const configPath = path.join(AGENTS_DIR, `${agentName}.md`);
  if (!existsSync(configPath)) {
    console.error(`[archangel:${agentName}] Config not found: ${configPath}`);
    process.exit(1);
  }

  const content = readFileSync(configPath, "utf-8");
  const configResult = parseAgentConfig(`${agentName}.md`, content);
  if (!configResult || "error" in configResult) {
    console.error(`[archangel:${agentName}] Invalid config`);
    process.exit(1);
  }
  const config = configResult;

  const agent = config.tool === "claude" ? ClaudeAgent : CodexAgent;
  const sessionName = generateArchangelSessionName(config);

  // Check agent CLI is installed before trying to start
  const cliCheck = spawnSync("which", [agent.name], { encoding: "utf-8" });
  if (cliCheck.status !== 0) {
    console.error(
      `[archangel:${agentName}] ERROR: ${agent.name} CLI is not installed or not in PATH`
    );
    process.exit(1);
  }

  // Start the agent session with safe defaults (auto-approve read-only operations)
  const command = agent.getCommand(false, sessionName);
  tmuxNewSession(sessionName, command);

  // Wait for agent to be ready
  const start = Date.now();
  while (Date.now() - start < ARCHANGEL_STARTUP_TIMEOUT_MS) {
    const screen = tmuxCapture(sessionName);
    const state = agent.getState(screen, sessionName);

    if (state === State.UPDATE_PROMPT) {
      await agent.handleUpdatePrompt(sessionName);
      continue;
    }

    // Handle bypass permissions confirmation dialog (Claude Code shows this for --dangerously-skip-permissions)
    if (
      screen.includes("Bypass Permissions mode") &&
      screen.includes("Yes, I accept")
    ) {
      console.log(
        `[archangel:${agentName}] Accepting bypass permissions dialog`
      );
      tmuxSend(sessionName, "2"); // Select "Yes, I accept"
      await sleep(300);
      tmuxSend(sessionName, "Enter");
      await sleep(500);
      continue;
    }

    if (state === State.READY) {
      console.log(`[archangel:${agentName}] Started session: ${sessionName}`);
      break;
    }

    await sleep(POLL_MS);
  }

  // Load the base prompt from config
  const normalized = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const promptMatch = normalized.match(/^---[\s\S]*?---\n([\s\S]*)$/);
  const basePrompt = promptMatch ? promptMatch[1].trim() : "Review for issues.";

  // File watching state
  /** @type {Set<string>} */
  let changedFiles = new Set();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let debounceTimer = undefined;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let maxWaitTimer = undefined;
  let isProcessing = false;
  const intervalMs = config.interval * 1000;

  // Hash tracking for incremental context updates
  /** @type {string | null} */
  let lastPlanHash = null;
  /** @type {string | null} */
  let lastTodosHash = null;
  let isFirstTrigger = true;

  async function processChanges() {
    clearTimeout(debounceTimer);
    clearTimeout(maxWaitTimer);
    debounceTimer = undefined;
    maxWaitTimer = undefined;

    if (changedFiles.size === 0 || isProcessing) return;
    isProcessing = true;

    const files = [...changedFiles];
    changedFiles = new Set(); // atomic swap to avoid losing changes during processing

    try {
      // Get parent session log path for JSONL extraction
      const parent = findParentSession();
      const logPath = parent
        ? findClaudeLogPath(parent.uuid, parent.session)
        : null;

      // Get orientation context (plan and todos) from parent session
      const meta = parent?.session ? getSessionMeta(parent.session) : null;
      const planContent = meta?.slug ? readPlanFile(meta.slug) : null;
      const todosContent = meta?.todos?.length ? formatTodos(meta.todos) : null;

      // Check if plan/todos have changed since last trigger
      const planHash = quickHash(planContent);
      const todosHash = quickHash(todosContent);
      const includePlan = planHash !== lastPlanHash;
      const includeTodos = todosHash !== lastTodosHash;

      // Update tracking for next trigger
      lastPlanHash = planHash;
      lastTodosHash = todosHash;

      // Build file-specific context from JSONL
      const fileContexts = [];
      for (const file of files.slice(0, 5)) {
        // Limit to 5 files
        const ctx = extractFileEditContext(logPath, file);
        if (ctx) {
          fileContexts.push({ file, ...ctx });
        }
      }

      // Build the prompt
      // First trigger: include intro, guidelines, and focus (archangel has memory)
      let prompt = isFirstTrigger
        ? `You are the archangel of ${agentName}.\n\n${ARCHANGEL_PREAMBLE}\n\n## Focus\n\n${basePrompt}\n\n---`
        : "";

      // Add orientation context (plan and todos) only if changed since last trigger
      if (includePlan && planContent) {
        prompt += (prompt ? "\n\n" : "") + "## Current Plan\n\n" + planContent;
      }
      if (includeTodos && todosContent) {
        prompt +=
          (prompt ? "\n\n" : "") + "## Current Todos\n\n" + todosContent;
      }

      if (fileContexts.length > 0) {
        prompt += "\n\n## Recent Edits (from parent session)\n";

        for (const ctx of fileContexts) {
          prompt += `\n### ${ctx.file}\n`;
          prompt += `**Intent:** ${ctx.intent.slice(0, 500)}\n`;
          prompt += `**Action:** ${ctx.toolCall.name}\n`;

          if (ctx.editSequence > 1) {
            prompt += `**Note:** This is edit #${ctx.editSequence} to this file (refinement)\n`;
          }

          if (ctx.subsequentErrors.length > 0) {
            prompt += `**Errors after:** ${ctx.subsequentErrors[0].slice(
              0,
              200
            )}\n`;
          }

          if (ctx.readsBefore.length > 0) {
            const reads = ctx.readsBefore
              .map((f) => f.split("/").pop())
              .join(", ");
            prompt += `**Files read before:** ${reads}\n`;
          }
        }

        prompt +=
          "\n\n## Files Changed\n  - " + files.slice(0, 10).join("\n  - ");

        const gitContext = buildGitContext(
          ARCHANGEL_GIT_CONTEXT_HOURS,
          ARCHANGEL_GIT_CONTEXT_MAX_LINES
        );
        if (gitContext) {
          prompt += "\n\n## Git Context\n\n" + gitContext;
        }

        prompt += "\n\nReview these changes.";
      } else {
        // Fallback: no JSONL context available, use conversation + git context
        const parentContext = getParentSessionContext(
          ARCHANGEL_PARENT_CONTEXT_ENTRIES
        );
        const gitContext = buildGitContext(
          ARCHANGEL_GIT_CONTEXT_HOURS,
          ARCHANGEL_GIT_CONTEXT_MAX_LINES
        );

        if (parentContext) {
          prompt +=
            "\n\n## Main Session Context\n\nThe user is currently working on:\n\n" +
            parentContext;
        }

        prompt +=
          "\n\n## Files Changed\n  - " + files.slice(0, 10).join("\n  - ");

        if (gitContext) {
          prompt += "\n\n## Git Context\n\n" + gitContext;
        }

        prompt += "\n\nReview these changes.";
      }

      // Check session still exists
      if (!tmuxHasSession(sessionName)) {
        console.log(`[archangel:${agentName}] Session gone, exiting`);
        process.exit(0);
      }

      // Wait for ready
      const screen = tmuxCapture(sessionName);
      const state = agent.getState(screen, sessionName);

      if (state === State.RATE_LIMITED) {
        console.error(`[archangel:${agentName}] Rate limited - stopping`);
        process.exit(2);
      }

      if (state !== State.READY) {
        console.log(
          `[archangel:${agentName}] Agent not ready (${state}), skipping`
        );
        isProcessing = false;
        return;
      }

      // Send prompt
      tmuxSendLiteral(sessionName, prompt);
      await sleep(200); // Allow time for large prompts to be processed
      tmuxSend(sessionName, "Enter");
      await sleep(100); // Ensure Enter is processed
      isFirstTrigger = false;

      // Wait for response
      const { state: endState, screen: afterScreen } = await waitForResponse(
        agent,
        sessionName,
        ARCHANGEL_RESPONSE_TIMEOUT_MS
      );

      if (endState === State.RATE_LIMITED) {
        console.error(`[archangel:${agentName}] Rate limited - stopping`);
        process.exit(2);
      }

      const cleanedResponse = agent.getResponse(sessionName, afterScreen) || "";

      const isSkippable =
        !cleanedResponse || cleanedResponse.trim() === "EMPTY_RESPONSE";

      if (!isSkippable) {
        writeToMailbox({
          agent: /** @type {string} */ (agentName),
          session: sessionName,
          branch: getCurrentBranch(),
          commit: getCurrentCommit(),
          files,
          message: cleanedResponse,
        });
        console.log(
          `[archangel:${agentName}] Wrote observation for ${files.length} file(s)`
        );
      }
    } catch (err) {
      console.error(
        `[archangel:${agentName}] Error:`,
        err instanceof Error ? err.message : err
      );
    }

    isProcessing = false;
  }

  function scheduleProcessChanges() {
    processChanges().catch((err) => {
      console.error(
        `[archangel:${agentName}] Unhandled error:`,
        err instanceof Error ? err.message : err
      );
    });
  }

  // Set up file watching
  const stopWatching = watchForChanges(config.watch, (filePath) => {
    changedFiles.add(filePath);

    // Debounce: reset timer on each change
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(scheduleProcessChanges, intervalMs);

    // Max wait: force trigger after 5x interval to prevent starvation
    if (!maxWaitTimer) {
      maxWaitTimer = setTimeout(scheduleProcessChanges, intervalMs * 5);
    }
  });

  // Check if session still exists periodically
  const sessionCheck = setInterval(() => {
    if (!tmuxHasSession(sessionName)) {
      console.log(`[archangel:${agentName}] Session gone, exiting`);
      stopWatching();
      clearInterval(sessionCheck);
      process.exit(0);
    }
  }, ARCHANGEL_HEALTH_CHECK_MS);

  // Handle graceful shutdown
  process.on("SIGTERM", () => {
    console.log(`[archangel:${agentName}] Received SIGTERM, shutting down`);
    stopWatching();
    clearInterval(sessionCheck);
    tmuxSend(sessionName, "C-c");
    setTimeout(() => {
      tmuxKill(sessionName);
      process.exit(0);
    }, 500);
  });

  process.on("SIGINT", () => {
    console.log(`[archangel:${agentName}] Received SIGINT, shutting down`);
    stopWatching();
    clearInterval(sessionCheck);
    tmuxSend(sessionName, "C-c");
    setTimeout(() => {
      tmuxKill(sessionName);
      process.exit(0);
    }, 500);
  });

  console.log(`[archangel:${agentName}] Watching: ${config.watch.join(", ")}`);

  // Keep the process alive
  await new Promise(() => {});
}

/**
 * @param {string | null} [name]
 */
async function cmdSummon(name = null) {
  const configs = loadAgentConfigs();

  // If name provided but doesn't exist, create it
  if (name) {
    const exists = configs.some((c) => c.name === name);
    if (!exists) {
      if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        console.log(
          "ERROR: Name must contain only letters, numbers, dashes, and underscores"
        );
        process.exit(1);
      }

      if (!existsSync(AGENTS_DIR)) {
        mkdirSync(AGENTS_DIR, { recursive: true });
      }

      const agentPath = path.join(AGENTS_DIR, `${name}.md`);
      const template = `---
tool: claude
watch: ["**/*.{ts,tsx,js,jsx,mjs,mts}"]
interval: 30
---

Review changed files for bugs, type errors, and edge cases.
`;
      writeFileSync(agentPath, template);
      console.log(`Created: ${agentPath}`);
      console.log(`Edit the file to customize, then run: ax summon ${name}`);
      return;
    }
  }

  if (configs.length === 0) {
    console.log(`No archangels found in ${AGENTS_DIR}/`);
    return;
  }

  const targetConfigs = name ? configs.filter((c) => c.name === name) : configs;

  ensureMailboxHookScript();

  const parentSession = findCurrentClaudeSession();
  if (parentSession) {
    console.log(
      `Parent session: ${parentSession.session || "(non-tmux)"} [${
        parentSession.uuid
      }]`
    );
  }

  for (const config of targetConfigs) {
    const sessionPattern = getArchangelSessionPattern(config);
    const existing = findArchangelSession(sessionPattern);

    if (!existing) {
      startArchangel(config, parentSession);
    } else {
      console.log(`Already running: ${config.name} (${existing})`);
    }
  }

  gcMailbox(24);
}

/**
 * @param {string | null} [name]
 */
async function cmdRecall(name = null) {
  const configs = loadAgentConfigs();

  if (configs.length === 0) {
    console.log(`No archangels found in ${AGENTS_DIR}/`);
    return;
  }

  const targetConfigs = name ? configs.filter((c) => c.name === name) : configs;

  if (name && targetConfigs.length === 0) {
    console.log(`ERROR: archangel '${name}' not found in ${AGENTS_DIR}/`);
    process.exit(1);
  }

  for (const config of targetConfigs) {
    const sessionPattern = getArchangelSessionPattern(config);
    const existing = findArchangelSession(sessionPattern);

    if (existing) {
      tmuxSend(existing, "C-c");
      await sleep(300);
      tmuxKill(existing);
      console.log(`Recalled: ${config.name} (${existing})`);
    } else {
      console.log(`Not running: ${config.name}`);
    }
  }
}

// Version of the hook script template - bump when making changes
const HOOK_SCRIPT_VERSION = "5";

function ensureMailboxHookScript() {
  const hooksDir = HOOKS_DIR;
  const scriptPath = path.join(hooksDir, "mailbox-inject.js");
  const versionMarker = `// VERSION: ${HOOK_SCRIPT_VERSION}`;

  // Check if script exists and is current version
  if (existsSync(scriptPath)) {
    const existing = readFileSync(scriptPath, "utf-8");
    if (existing.includes(versionMarker)) return;
    // Outdated version, regenerate
  }

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  const hookCode = `#!/usr/bin/env node
${versionMarker}
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const AI_DIR = join(__dirname, "..");
const DEBUG = process.env.AX_DEBUG === "1";
const MAILBOX = join(AI_DIR, "mailbox.jsonl");
const MAX_AGE_MS = 60 * 60 * 1000;

function getTmuxSessionName() {
  if (!process.env.TMUX) return null;
  try {
    return execSync("tmux display-message -p '#S'", { encoding: "utf-8" }).trim();
  } catch {
    return null;
  }
}

// Read hook input from stdin
let hookInput = {};
try {
  const stdinData = readFileSync(0, "utf-8").trim();
  if (stdinData) hookInput = JSON.parse(stdinData);
} catch (err) {
  if (DEBUG) console.error("[hook] stdin parse:", err.message);
}

const sessionId = hookInput.session_id || "";
const hookEvent = hookInput.hook_event_name || "";

if (DEBUG) console.error("[hook] session:", sessionId, "event:", hookEvent);

const tmuxSession = getTmuxSessionName();
if (DEBUG) console.error("[hook] tmux session:", tmuxSession);
if (tmuxSession && (tmuxSession.includes("-archangel-") || tmuxSession.includes("-partner-"))) {
  if (DEBUG) console.error("[hook] skipping non-parent session");
  process.exit(0);
}

// Per-session last-seen tracking (single JSON file, self-cleaning)
const sessionHash = sessionId ? createHash("md5").update(sessionId).digest("hex").slice(0, 8) : "default";
const LAST_SEEN_FILE = join(AI_DIR, "mailbox-last-seen.json");

if (!existsSync(MAILBOX)) process.exit(0);

let lastSeenMap = {};
try {
  if (existsSync(LAST_SEEN_FILE)) {
    lastSeenMap = JSON.parse(readFileSync(LAST_SEEN_FILE, "utf-8"));
  }
} catch (err) {
  if (DEBUG) console.error("[hook] readLastSeen:", err.message);
}
const lastSeen = lastSeenMap[sessionHash] || 0;

const now = Date.now();
const lines = readFileSync(MAILBOX, "utf-8").trim().split("\\n").filter(Boolean);
const relevant = [];

for (const line of lines) {
  try {
    const entry = JSON.parse(line);
    const ts = new Date(entry.timestamp).getTime();
    const age = now - ts;
    if (age < MAX_AGE_MS && ts > lastSeen) {
      const session = entry.payload.session || "";
      const sessionPrefix = session.replace(/-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "");
      relevant.push({ agent: entry.payload.agent, sessionPrefix, message: entry.payload.message });
    }
  } catch (err) {
    if (DEBUG) console.error("[hook] parseLine:", err.message);
  }
}

if (relevant.length > 0) {
  const sessionPrefixes = new Set();
  let messageLines = [];
  messageLines.push("## Background Agents");
  messageLines.push("");
  messageLines.push("Background agents watching your files found:");
  messageLines.push("");
  for (const { agent, sessionPrefix, message } of relevant) {
    if (sessionPrefix) sessionPrefixes.add(sessionPrefix);
    messageLines.push("**[" + agent + "]**");
    messageLines.push("");
    messageLines.push(message);
    messageLines.push("");
  }
  const sessionList = [...sessionPrefixes].map(s => "\\\`./ax.js log " + s + "\\\`").join(" or ");
  messageLines.push("> For more context: \\\`./ax.js mailbox\\\`" + (sessionList ? " or " + sessionList : ""));

  const formattedMessage = messageLines.join("\\n");

  // For Stop hook, return blocking JSON to force acknowledgment
  if (hookEvent === "Stop") {
    console.log(JSON.stringify({ decision: "block", reason: formattedMessage }));
  } else if (hookEvent === "PreToolUse") {
    // For PreToolUse, use JSON with hookSpecificOutput to inject into Claude's context
    console.log(JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext: formattedMessage
      }
    }));
  } else {
    // For UserPromptSubmit, plain text stdout is automatically added to context
    console.log(formattedMessage);
  }

  // Update last-seen and prune entries older than 24 hours
  const PRUNE_AGE_MS = 24 * 60 * 60 * 1000;
  lastSeenMap[sessionHash] = now;
  for (const key of Object.keys(lastSeenMap)) {
    if (now - lastSeenMap[key] > PRUNE_AGE_MS) delete lastSeenMap[key];
  }
  writeFileSync(LAST_SEEN_FILE, JSON.stringify(lastSeenMap));
}

process.exit(0);
`;

  writeFileSync(scriptPath, hookCode);
  console.log(`Generated hook script: ${scriptPath}`);

  // Configure the hook in .claude/settings.json at the same time
  const configuredHook = ensureClaudeHookConfig();
  if (!configuredHook) {
    console.log(`\nTo enable manually, add to .claude/settings.json:\n`);
    console.log(`{
  "hooks": {
    "UserPromptSubmit": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node .ai/hooks/mailbox-inject.js", "timeout": 5 }] }],
    "PreToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node .ai/hooks/mailbox-inject.js", "timeout": 5 }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node .ai/hooks/mailbox-inject.js", "timeout": 5 }] }]
  }
}`);
  }
}

function ensureClaudeHookConfig() {
  const settingsDir = ".claude";
  const settingsPath = path.join(settingsDir, "settings.json");
  const hookCommand = "node .ai/hooks/mailbox-inject.js";
  const hookEvents = ["UserPromptSubmit", "PreToolUse", "Stop"];

  try {
    /** @type {ClaudeSettings} */
    let settings = {};

    // Load existing settings if present
    if (existsSync(settingsPath)) {
      const content = readFileSync(settingsPath, "utf-8");
      settings = JSON.parse(content);
    } else {
      // Create directory if needed
      if (!existsSync(settingsDir)) {
        mkdirSync(settingsDir, { recursive: true });
      }
    }

    // Ensure hooks structure exists
    if (!settings.hooks) settings.hooks = {};

    let anyAdded = false;

    for (const eventName of hookEvents) {
      if (!settings.hooks[eventName]) settings.hooks[eventName] = [];

      // Check if our hook is already configured for this event
      const hookExists = settings.hooks[eventName].some(
        /** @param {{hooks?: Array<{command: string}>}} entry */
        (entry) =>
          entry.hooks?.some(
            /** @param {{command: string}} h */ (h) => h.command === hookCommand
          )
      );

      if (!hookExists) {
        // Add the hook for this event
        settings.hooks[eventName].push({
          matcher: "",
          hooks: [
            {
              type: "command",
              command: hookCommand,
              timeout: 5,
            },
          ],
        });
        anyAdded = true;
      }
    }

    if (anyAdded) {
      // Write settings
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + "\n");
      console.log(`Configured hooks in: ${settingsPath}`);
    }

    return true;
  } catch {
    // If we can't configure automatically, return false so manual instructions are shown
    return false;
  }
}

/**
 * @param {string | null | undefined} session
 * @param {{all?: boolean, orphans?: boolean, force?: boolean}} [options]
 */
function cmdKill(
  session,
  { all = false, orphans = false, force = false } = {}
) {
  // Handle orphaned processes
  if (orphans) {
    const orphanedProcesses = findOrphanedProcesses();

    if (orphanedProcesses.length === 0) {
      console.log("No orphaned processes found");
      return;
    }

    const signal = force ? "-9" : "-15"; // SIGKILL vs SIGTERM
    let killed = 0;
    for (const { pid, command } of orphanedProcesses) {
      const result = spawnSync("kill", [signal, pid]);
      if (result.status === 0) {
        console.log(`Killed: PID ${pid} (${command.slice(0, 40)})`);
        killed++;
      }
    }
    console.log(
      `Killed ${killed} orphaned process(es)${force ? " (forced)" : ""}`
    );
    return;
  }

  // If specific session provided, kill just that one
  if (session) {
    if (!tmuxHasSession(session)) {
      console.log(
        "ERROR: session not found. Run 'ax agents' to list sessions."
      );
      process.exit(1);
    }
    tmuxKill(session);
    console.log(`Killed: ${session}`);
    return;
  }

  const allSessions = tmuxListSessions();
  const agentSessions = allSessions.filter((s) => parseSessionName(s));

  if (agentSessions.length === 0) {
    console.log("No agents running");
    return;
  }

  // Filter to current project unless --all specified
  let sessionsToKill = agentSessions;
  if (!all) {
    const currentProject = PROJECT_ROOT;
    sessionsToKill = agentSessions.filter((s) => {
      const cwd = getTmuxSessionCwd(s);
      return cwd && cwd.startsWith(currentProject);
    });

    if (sessionsToKill.length === 0) {
      console.log(`No agents running in ${currentProject}`);
      console.log(
        `(Use --all to kill all ${agentSessions.length} agent(s) across all projects)`
      );
      return;
    }
  }

  for (const s of sessionsToKill) {
    tmuxKill(s);
    console.log(`Killed: ${s}`);
  }
  console.log(`Killed ${sessionsToKill.length} agent(s)`);
}

/**
 * @param {string | null | undefined} session
 */
function cmdAttach(session) {
  if (!session) {
    console.log("ERROR: no session specified. Run 'agents' to list sessions.");
    process.exit(1);
  }

  // Resolve partial session name
  const resolved = resolveSessionName(session);
  if (!resolved || !tmuxHasSession(resolved)) {
    console.log("ERROR: session not found. Run 'ax agents' to list sessions.");
    process.exit(1);
  }

  // Hand over to tmux attach
  const result = spawnSync("tmux", ["attach", "-t", resolved], {
    stdio: "inherit",
  });
  process.exit(result.status || 0);
}

/**
 * @param {string | null | undefined} sessionName
 * @param {{tail?: number, reasoning?: boolean, follow?: boolean}} [options]
 */
function cmdLog(
  sessionName,
  { tail = 50, reasoning = false, follow = false } = {}
) {
  if (!sessionName) {
    console.log("ERROR: no session specified. Run 'agents' to list sessions.");
    process.exit(1);
  }

  // Resolve partial session name
  const resolved = resolveSessionName(sessionName);
  if (!resolved) {
    console.log("ERROR: session not found. Run 'ax agents' to list sessions.");
    process.exit(1);
  }
  const parsed = parseSessionName(resolved);
  if (!parsed) {
    console.log("ERROR: invalid session name");
    process.exit(1);
  }

  const agent = parsed.tool === "claude" ? ClaudeAgent : CodexAgent;
  const logPath = agent.findLogPath(resolved);
  if (!logPath || !existsSync(logPath)) {
    console.log("ERROR: log file not found");
    process.exit(1);
  }

  const displayName = resolved;

  // Print initial content
  let lastLineCount = 0;
  /** @type {string | null} */
  let lastTimestamp = null;

  /**
   * @param {boolean} [isInitial]
   */
  function printLog(isInitial = false) {
    const content = readFileSync(/** @type {string} */ (logPath), "utf-8");
    const lines = content.trim().split("\n").filter(Boolean);

    // Handle log rotation: if file was truncated, reset our position
    if (lines.length < lastLineCount) {
      lastLineCount = 0;
    }

    // For initial print, take last N. For follow, take only new lines.
    const startIdx = isInitial
      ? Math.max(0, lines.length - tail)
      : lastLineCount;
    const newLines = lines.slice(startIdx);
    lastLineCount = lines.length;

    if (newLines.length === 0) return;

    const entries = newLines
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const output = [];
    if (isInitial) {
      output.push(`## ${displayName}\n`);
    }

    for (const entry of /** @type {any[]} */ (entries)) {
      const formatted = formatLogEntry(entry, { reasoning });
      if (formatted) {
        const ts = entry.timestamp || entry.ts || entry.createdAt;
        if (ts && ts !== lastTimestamp) {
          const date = new Date(ts);
          const timeStr = date.toLocaleTimeString("en-GB", {
            hour: "2-digit",
            minute: "2-digit",
          });
          if (formatted.isUserMessage) {
            output.push(`\n### ${timeStr}\n`);
          }
          lastTimestamp = ts;
        }
        output.push(formatted.text);
      }
    }

    if (output.length > 0) {
      console.log(output.join("\n"));
    }
  }

  // Print initial content
  printLog(true);

  if (!follow) return;

  // Watch for changes
  const watcher = watch(logPath, () => {
    printLog(false);
  });

  // Handle exit
  process.on("SIGINT", () => {
    watcher.close();
    process.exit(0);
  });
}

/**
 * @param {any} entry
 * @param {{reasoning?: boolean}} [options]
 * @returns {{text: string, isUserMessage: boolean} | null}
 */
function formatLogEntry(entry, { reasoning = false } = {}) {
  // Handle different log formats (Claude, Codex)

  // Claude Code format: { type: "user" | "assistant", message: { content: ... } }
  // Codex format: { role: "user" | "assistant", content: ... }

  const type = entry.type || entry.role;
  const message = entry.message || entry;
  const content = message.content;

  if (type === "user" || type === "human") {
    const text = extractTextContent(content);
    if (text) {
      return {
        text: `**User**: ${truncate(text, TRUNCATE_USER_LEN)}\n`,
        isUserMessage: true,
      };
    }
  }

  if (type === "assistant") {
    const parts = [];

    // Extract text response
    const text = extractTextContent(content);
    if (text) {
      parts.push(`**Assistant**: ${text}\n`);
    }

    // Extract tool calls (compressed)
    const tools = extractToolCalls(content);
    if (tools.length > 0) {
      const toolSummary = tools
        .map((t) => {
          if (t.error) return `${t.name}(${t.target}) ✗`;
          return `${t.name}(${t.target})`;
        })
        .join(", ");
      parts.push(`> ${toolSummary}\n`);
    }

    // Extract thinking/reasoning if requested
    if (reasoning) {
      const thinking = extractThinking(content);
      if (thinking) {
        parts.push(
          `> *Thinking*: ${truncate(thinking, TRUNCATE_THINKING_LEN)}\n`
        );
      }
    }

    if (parts.length > 0) {
      return { text: parts.join(""), isUserMessage: false };
    }
  }

  // Handle tool results with errors
  if (type === "tool_result" || type === "tool") {
    const error = entry.error || entry.is_error;
    if (error) {
      const name = entry.tool_name || entry.name || "tool";
      return {
        text: `> ${name} ✗ (${truncate(String(error), 100)})\n`,
        isUserMessage: false,
      };
    }
  }

  return null;
}

/**
 * @param {any} content
 * @returns {string | null}
 */
function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const textParts = content
      .filter((c) => c.type === "text")
      .map((c) => c.text)
      .filter(Boolean);
    return textParts.join("\n");
  }
  if (content?.text) return content.text;
  return null;
}

/**
 * @param {any} content
 * @returns {{name: string, target: string, error?: any}[]}
 */
function extractToolCalls(content) {
  if (!Array.isArray(content)) return [];

  return content
    .filter((c) => c.type === "tool_use" || c.type === "tool_call")
    .map((c) => {
      const name = c.name || c.tool || "tool";
      const input = c.input || c.arguments || {};
      // Extract a reasonable target from the input
      const target =
        input.file_path ||
        input.path ||
        input.command?.slice(0, 30) ||
        input.pattern ||
        "";
      const shortTarget = target.split("/").pop() || target.slice(0, 20);
      return { name, target: shortTarget, error: c.error };
    });
}

/**
 * @param {any} content
 * @returns {string | null}
 */
function extractThinking(content) {
  if (Array.isArray(content)) {
    const thinking = content.find((c) => c.type === "thinking");
    if (thinking) return thinking.thinking || thinking.text;
  }
  return null;
}

/**
 * @param {string} str
 * @param {number} maxLen
 * @returns {string}
 */
function truncate(str, maxLen) {
  if (!str) return "";
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "...";
}

/**
 * @param {{limit?: number, branch?: string | null, all?: boolean}} [options]
 */
function cmdMailbox({ limit = 20, branch = null, all = false } = {}) {
  const maxAge = all ? Infinity : MAILBOX_MAX_AGE_MS;
  const entries = readMailbox({ maxAge, branch, limit });

  if (entries.length === 0) {
    console.log(
      "No mailbox entries" + (branch ? ` for branch '${branch}'` : "")
    );
    return;
  }

  console.log("## Mailbox\n");

  for (const entry of entries) {
    const ts = new Date(entry.timestamp);
    const timeStr = ts.toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const dateStr = ts.toLocaleDateString("en-GB", {
      month: "short",
      day: "numeric",
    });
    const p = entry.payload || {};

    console.log(`### [${p.agent || "unknown"}] ${dateStr} ${timeStr}\n`);

    if (p.branch || p.commit) {
      console.log(`**Branch**: ${p.branch || "?"} @ ${p.commit || "?"}\n`);
    }

    if (p.rfpId) {
      console.log(`**RFP**: ${p.rfpId}\n`);
    }

    if (entry.type === "proposal") {
      console.log(`**Proposal**: ${p.message || ""}\n`);
    } else if (p.message) {
      console.log(`**Assistant**: ${p.message}\n`);
    }

    if (p.files?.length > 0) {
      const fileList = p.files.map((f) => f.split("/").pop()).join(", ");
      const more = p.files.length > 5 ? ` (+${p.files.length - 5} more)` : "";
      console.log(`> Read(${fileList}${more})\n`);
    }

    console.log("---\n");
  }
}

/**
 * @param {string} rfpId
 * @param {string} archangel
 * @returns {string | null}
 */
function getProposalFromMailbox(rfpId, archangel) {
  if (!existsSync(MAILBOX_PATH)) return null;
  let result = null;
  try {
    const lines = readFileSync(MAILBOX_PATH, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry?.type !== "proposal") continue;
        const p = entry.payload || {};
        if (p.rfpId === rfpId && p.archangel === archangel) {
          result = p.message || "";
        }
      } catch {
        // Skip malformed lines
      }
    }
  } catch (err) {
    debugError("getProposalFromMailbox", err);
  }
  return result;
}

/**
 * @param {string} prompt
 * @param {{archangels?: string, fresh?: boolean, noWait?: boolean}} [options]
 */
async function cmdRfp(
  prompt,
  { archangels, fresh = false, noWait = false } = {}
) {
  const configs = loadAgentConfigs();
  if (configs.length === 0) {
    console.log(`No archangels found in ${AGENTS_DIR}/`);
    process.exit(1);
  }

  const requested = archangels
    ? archangels
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : configs.map((c) => c.name);

  if (requested.length === 0) {
    console.log("ERROR: no archangels specified");
    process.exit(1);
  }

  const missing = requested.filter(
    (name) => !configs.some((c) => c.name === name)
  );
  if (missing.length > 0) {
    console.log(`ERROR: unknown archangel(s): ${missing.join(", ")}`);
    process.exit(1);
  }

  const parent = findParentSession();
  const rfpId = generateRfpId(parent);

  for (const name of requested) {
    const config = configs.find((c) => c.name === name);
    if (!config) continue;

    const pattern = getArchangelSessionPattern(config);
    let session = findArchangelSession(pattern);
    if (!session) {
      startArchangel(config, parent);
      session = await waitForArchangelSession(pattern);
    }

    if (!session) {
      console.log(`ERROR: failed to start archangel '${name}'`);
      continue;
    }

    const { agent } = resolveAgent({ sessionName: session });

    if (fresh) {
      tmuxSendLiteral(session, "/new");
      await sleep(50);
      tmuxSend(session, "Enter");
    }

    const ready = await waitUntilReady(
      agent,
      session,
      ARCHANGEL_STARTUP_TIMEOUT_MS
    );
    if (ready.state !== State.READY) {
      console.log(`[rfp] ${name} not ready (${ready.state}), skipping`);
      continue;
    }

    const rfpPrompt = `## RFP ${rfpId}\n\n${RFP_PREAMBLE}\n\n${prompt}\n\nReturn exactly one proposal.`;
    tmuxSendLiteral(session, rfpPrompt);
    await sleep(200);
    tmuxSend(session, "Enter");
  }

  writeRfpRecord(rfpId, prompt);
  const archangelList = requested.join(",");
  const base = rfpId.split("-")[1];
  const shortId = `rfp-${base}`;
  console.log(`rfp: ${rfpId} (${archangelList})`);
  if (noWait) {
    // Truncate prompt for display (first line, max 60 chars)
    const firstLine = prompt.split("\n")[0];
    const taskPreview =
      firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;

    let output = `Task: ${taskPreview}

Add this to your task list, then continue with your work.`;

    // Show TaskCreate example if caller is Claude
    const caller = findCallerAgent();
    if (caller?.agent === "claude") {
      output += `

e.g.
  TaskCreate({ subject: "ax:${shortId} - ${taskPreview}" })
`;
    }

    console.log(output);
  }
}

/**
 * @param {string} rfpId
 * @param {{archangels?: string, timeoutMs?: number}} [options]
 */
async function cmdRfpWait(
  rfpId,
  { archangels, timeoutMs = ARCHANGEL_RESPONSE_TIMEOUT_MS } = {}
) {
  const resolvedRfpId = resolveRfpId(rfpId);
  const configs = loadAgentConfigs();
  if (configs.length === 0) {
    console.log(`No archangels found in ${AGENTS_DIR}/`);
    process.exit(1);
  }

  const requested = archangels
    ? archangels
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : configs.map((c) => c.name);

  if (requested.length === 0) {
    console.log("ERROR: no archangels specified");
    process.exit(1);
  }

  const missing = requested.filter(
    (name) => !configs.some((c) => c.name === name)
  );
  if (missing.length > 0) {
    console.log(`ERROR: unknown archangel(s): ${missing.join(", ")}`);
    process.exit(1);
  }

  let wroteAny = false;
  let printedAny = false;

  for (const name of requested) {
    const config = configs.find((c) => c.name === name);
    if (!config) continue;

    const pattern = getArchangelSessionPattern(config);
    const session = findArchangelSession(pattern);
    if (!session) {
      console.log(`[rfp] ${name} session not found, skipping`);
      continue;
    }

    const existing = getProposalFromMailbox(resolvedRfpId, name);
    if (existing !== null) {
      if (printedAny) console.log("");
      console.log(`[${name}]`);
      console.log(existing);
      wroteAny = true;
      printedAny = true;
      continue;
    }

    const { agent } = resolveAgent({ sessionName: session });
    let result;
    try {
      result = await waitUntilReady(agent, session, timeoutMs);
    } catch (err) {
      if (err instanceof TimeoutError) {
        console.log(`[rfp] ${name} timed out`);
      } else {
        console.log(
          `[rfp] ${name} error: ${err instanceof Error ? err.message : err}`
        );
      }
      continue;
    }

    if (result.state === State.RATE_LIMITED) {
      console.log(`[rfp] ${name} rate limited`);
      continue;
    }
    if (result.state === State.CONFIRMING) {
      console.log(`[rfp] ${name} awaiting confirmation`);
      continue;
    }

    const response = agent.getResponse(session, result.screen) || "";
    if (!response || response.trim() === "EMPTY_RESPONSE") {
      continue;
    }

    writeToMailbox(
      {
        agent: name,
        session,
        branch: getCurrentBranch(),
        commit: getCurrentCommit(),
        files: [],
        message: response,
        rfpId: resolvedRfpId,
        archangel: name,
      },
      "proposal"
    );
    if (printedAny) console.log("");
    console.log(`[${name}]`);
    console.log(response);
    wroteAny = true;
    printedAny = true;
  }

  if (!wroteAny) process.exit(1);
}

/**
 * @param {Agent} agent
 * @param {string | null | undefined} session
 * @param {string} message
 * @param {{noWait?: boolean, yolo?: boolean, allowedTools?: string | null, timeoutMs?: number}} [options]
 */
async function cmdAsk(
  agent,
  session,
  message,
  {
    noWait = false,
    yolo = false,
    allowedTools = null,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {}
) {
  const sessionExists = session != null && tmuxHasSession(session);
  const nativeYolo =
    sessionExists && isYoloSession(/** @type {string} */ (session));

  // Cannot use --yolo --no-wait on a safe session: we need to stay and auto-approve
  if (yolo && noWait && sessionExists && !nativeYolo) {
    console.log(
      "ERROR: --yolo requires waiting on a session not started with --yolo"
    );
    console.log(
      "Restart the session with --yolo, or allow waiting for auto-approval"
    );
    process.exit(1);
  }

  /** @type {string} */
  const activeSession = sessionExists
    ? /** @type {string} */ (session)
    : await cmdStart(agent, session, { yolo, allowedTools });

  if (sessionExists) {
    await waitUntilReady(agent, activeSession, timeoutMs);
    tmuxSend(activeSession, "C-u"); // Clear any stale input
    await sleep(50);
  }

  await tmuxSendText(activeSession, message);

  if (noWait) {
    const parsed = parseSessionName(activeSession);
    const shortId = parsed?.uuid?.slice(0, 8) || activeSession;
    // Truncate message for display (first line, max 60 chars)
    const firstLine = message.split("\n")[0];
    const taskPreview =
      firstLine.length > 60 ? firstLine.slice(0, 57) + "..." : firstLine;

    let output = `Sent to: ${shortId}
Task: ${taskPreview}

Add this to your task list, then continue with your work.`;

    // Show TaskCreate example if caller is Claude
    const caller = findCallerAgent();
    if (caller?.agent === "claude") {
      output += `

e.g.
  TaskCreate({ subject: "ax:${shortId} - ${taskPreview}" })
`;
    }

    console.log(output);
    return;
  }

  const useAutoApprove = yolo && !nativeYolo;

  const { state, screen } = useAutoApprove
    ? await autoApproveLoop(agent, activeSession, timeoutMs, streamResponse)
    : await streamResponse(agent, activeSession, timeoutMs);

  if (state === State.RATE_LIMITED) {
    console.log(`RATE_LIMITED: ${agent.parseRetryTime(screen)}`);
    process.exit(2);
  }

  if (state === State.CONFIRMING) {
    console.log(`CONFIRM: ${formatConfirmationOutput(screen, agent)}`);
    process.exit(3);
  }
}

/**
 * @param {Agent} agent
 * @param {string} prompt
 * @param {{name?: string, maxLoops?: number, loop?: boolean, reset?: boolean, session?: string | null, yolo?: boolean, timeoutMs?: number}} [options]
 */
async function cmdDo(agent, prompt, options = {}) {
  const maxLoops = options.maxLoops || 10;
  const name = options.name || "default";
  const loop = options.loop || false;
  const reset = options.reset || false;
  const yolo = options.yolo ?? true;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;

  // Reset progress file if requested
  if (reset) {
    const progressPath = getDoProgressPath(name);
    writeFileSync(progressPath, "");
  }

  // Use provided session or start a new one
  const sessionExists = options.session && tmuxHasSession(options.session);
  const session = options.session
    ? await cmdStart(agent, options.session, { yolo })
    : await cmdStart(agent, null, { yolo });

  // If reusing existing session, wait for ready and clear stale input
  if (sessionExists) {
    await waitUntilReady(agent, session, timeoutMs);
    tmuxSend(session, "C-u");
    await sleep(50);
  }

  // Print session ID for targeting approvals when not in yolo mode
  if (!yolo) {
    const parsed = parseSessionName(session);
    const shortId = parsed?.uuid?.slice(0, 8) || session;
    console.error(`Session: ${shortId}`);
  }

  const iterations = loop ? maxLoops : 1;

  for (let i = 0; i < iterations; i++) {
    // Fresh context (except first iteration)
    if (i > 0) {
      tmuxSendLiteral(session, "/new");
      tmuxSend(session, "Enter");
      await waitUntilReady(agent, session, timeoutMs);
    }

    // Build prompt with preamble + progress context
    const fullPrompt = buildDoPrompt(prompt, name);

    // Send prompt and submit
    await tmuxSendText(session, fullPrompt);

    const { state, screen } = yolo
      ? await autoApproveLoop(agent, session, timeoutMs, streamResponse)
      : await streamResponse(agent, session, timeoutMs);

    if (state === State.RATE_LIMITED) {
      console.log(`\nRate limited: ${agent.parseRetryTime(screen)}`);
      process.exit(2);
    }

    if (state === State.CONFIRMING) {
      const parsed = parseSessionName(session);
      const shortId = parsed?.uuid?.slice(0, 8) || session;
      console.log(
        `\nAwaiting confirmation: ${formatConfirmationOutput(screen, agent)}`
      );
      console.log(`Add --session=${shortId} if you have multiple sessions`);
      console.log("Use 'ax approve --wait' or 'ax reject' to continue");
      process.exit(3);
    }

    const response = agent.getResponse(session, screen) || "";

    // Check completion
    if (response.includes("<promise>COMPLETE</promise>")) {
      console.log(`\nCompleted after ${i + 1} iteration(s)`);
      return;
    }

    // Single iteration mode (default): exit with code 5 to signal "more work"
    if (!loop) {
      console.log(
        `\nIteration complete. Re-run to continue, or --reset to start over.`
      );
      process.exit(5);
    }

    console.log(`\n--- Iteration ${i + 1}/${maxLoops} complete ---`);
  }

  console.log(`\nReached max iterations (${maxLoops}) without completion`);
  process.exit(1);
}

/**
 * @param {Agent} agent
 * @param {string | null | undefined} session
 * @param {{wait?: boolean, timeoutMs?: number}} [options]
 */
async function cmdApprove(agent, session, { wait = false, timeoutMs } = {}) {
  if (!session || !tmuxHasSession(session)) {
    console.log("ERROR: no session");
    process.exit(1);
  }

  const before = tmuxCapture(session);
  const beforeState = agent.getState(before, session);
  if (beforeState !== State.CONFIRMING) {
    console.log(`Already ${beforeState}`);
    return;
  }

  tmuxSend(session, agent.approveKey);

  if (!wait) return;

  const { state, screen } = await waitForResponse(agent, session, timeoutMs);

  if (state === State.RATE_LIMITED) {
    console.log(`RATE_LIMITED: ${agent.parseRetryTime(screen)}`);
    process.exit(2);
  }

  if (state === State.CONFIRMING) {
    console.log(`CONFIRM: ${formatConfirmationOutput(screen, agent)}`);
    process.exit(3);
  }

  const response = agent.getResponse(session, screen);
  console.log(response || "");
}

/**
 * @param {Agent} agent
 * @param {string | null | undefined} session
 * @param {{wait?: boolean, timeoutMs?: number}} [options]
 */
async function cmdReject(agent, session, { wait = false, timeoutMs } = {}) {
  if (!session || !tmuxHasSession(session)) {
    console.log("ERROR: no session");
    process.exit(1);
  }

  const before = tmuxCapture(session);
  const beforeState = agent.getState(before, session);
  if (beforeState !== State.CONFIRMING) {
    console.log(`Already ${beforeState}`);
    return;
  }

  tmuxSend(session, agent.rejectKey);

  if (!wait) return;

  const { state, screen } = await waitForResponse(agent, session, timeoutMs);

  if (state === State.RATE_LIMITED) {
    console.log(`RATE_LIMITED: ${agent.parseRetryTime(screen)}`);
    process.exit(2);
  }

  const response = agent.getResponse(session, screen);
  console.log(response || "");
}

/**
 * @param {Agent} agent
 * @param {string | null | undefined} session
 * @param {string | null | undefined} option
 * @param {string | null | undefined} customInstructions
 * @param {{wait?: boolean, yolo?: boolean, fresh?: boolean, timeoutMs?: number}} [options]
 */
async function cmdReview(
  agent,
  session,
  option,
  customInstructions,
  {
    wait = true,
    yolo = false,
    fresh = false,
    timeoutMs = REVIEW_TIMEOUT_MS,
  } = {}
) {
  const validOptions = ["uncommitted", "custom", "branch", "commit"];
  if (option && !validOptions.includes(option)) {
    console.error(`Unknown review option: ${option}`);
    console.error(`Valid options: ${validOptions.join(", ")}`);
    process.exit(1);
  }

  const sessionExists = session != null && tmuxHasSession(session);

  // Reset conversation if --fresh and session exists
  if (fresh && sessionExists) {
    tmuxSendLiteral(/** @type {string} */ (session), "/new");
    await sleep(50);
    tmuxSend(/** @type {string} */ (session), "Enter");
    await waitUntilReady(
      agent,
      /** @type {string} */ (session),
      STARTUP_TIMEOUT_MS
    );
  }

  // Claude: use prompt-based review (no /review command)
  if (!agent.reviewOptions) {
    /** @type {Record<string, string>} */
    const reviewPrompts = {
      uncommitted: "Review uncommitted changes.",
      branch: customInstructions
        ? `Review changes on the current branch compared to ${customInstructions}.`
        : "Review changes on the current branch compared to main.",
      commit: customInstructions
        ? `Review commit ${customInstructions}.`
        : "Review the most recent commit.",
      custom: customInstructions || "Review the code.",
    };
    const prompt =
      (option && reviewPrompts[option]) || reviewPrompts.uncommitted;
    debug("review", `Claude path: noWait=${!wait}, timeoutMs=${timeoutMs}`);
    return cmdAsk(agent, session, prompt, { noWait: !wait, yolo, timeoutMs });
  }

  // AX_REVIEW_MODE=exec: bypass /review command, send instructions directly
  if (
    process.env.AX_REVIEW_MODE === "exec" &&
    option === "custom" &&
    customInstructions
  ) {
    return cmdAsk(agent, session, customInstructions, {
      noWait: !wait,
      yolo,
      timeoutMs,
    });
  }
  const nativeYolo =
    sessionExists && isYoloSession(/** @type {string} */ (session));

  // Cannot use --yolo without --wait on a safe session: we need to stay and auto-approve
  if (yolo && !wait && sessionExists && !nativeYolo) {
    console.log(
      "ERROR: --yolo requires waiting on a session not started with --yolo"
    );
    console.log(
      "Restart the session with --yolo, or allow waiting for auto-approval"
    );
    process.exit(1);
  }

  /** @type {string} */
  const activeSession = sessionExists
    ? /** @type {string} */ (session)
    : await cmdStart(agent, session, { yolo });

  if (sessionExists) {
    await waitUntilReady(agent, activeSession, timeoutMs);
    tmuxSend(activeSession, "C-u"); // Clear any stale input
    await sleep(50);
  }

  debug("review", `Codex path: sending /review command`);
  tmuxSendLiteral(activeSession, "/review");
  await sleep(50);
  tmuxSend(activeSession, "Enter");

  debug("review", `waiting for review menu`);
  await waitFor(
    activeSession,
    (s) => s.includes("Select a review preset") || s.includes("review")
  );

  if (option) {
    const key = agent.reviewOptions[option] || option;
    debug("review", `selecting option=${option} (key=${key})`);
    tmuxSend(activeSession, key);

    if (option === "custom" && customInstructions) {
      debug("review", `waiting for custom instructions prompt`);
      await waitFor(
        activeSession,
        (s) => s.includes("custom") || s.includes("instructions")
      );
      tmuxSendLiteral(activeSession, customInstructions);
      await sleep(50);
      tmuxSend(activeSession, "Enter");
    } else if (option === "branch") {
      debug("review", `waiting for branch picker`);
      await waitFor(
        activeSession,
        (s) => !s.includes("Select a review preset")
      );
      await sleep(200);
      if (customInstructions) {
        debug("review", `typing branch filter: ${customInstructions}`);
        tmuxSendLiteral(activeSession, customInstructions);
        await sleep(100);
      }
      tmuxSend(activeSession, "Enter");
    } else if (option === "commit") {
      debug("review", `waiting for commit picker`);
      await waitFor(
        activeSession,
        (s) => !s.includes("Select a review preset")
      );
      await sleep(200);
      if (customInstructions) {
        // Codex commit picker shows messages, not hashes - resolve ref to message
        let searchTerm = customInstructions;
        const gitResult = spawnSync(
          "git",
          ["log", "--format=%s", "-n", "1", customInstructions],
          {
            encoding: "utf-8",
          }
        );
        if (gitResult.status === 0 && gitResult.stdout.trim()) {
          // Use first few words of commit message for search
          searchTerm = gitResult.stdout.trim().slice(0, 40);
          debug(
            "review",
            `resolved commit ${customInstructions} -> "${searchTerm}"`
          );
        }
        debug("review", `typing commit filter: ${searchTerm}`);
        tmuxSendLiteral(activeSession, searchTerm);
        await sleep(100);
      }
      tmuxSend(activeSession, "Enter");
    }
  }

  if (!wait) return;

  // Reviews should always auto-approve (unless session is already yolo)
  const useAutoApprove = !nativeYolo;

  const { state, screen } = useAutoApprove
    ? await autoApproveLoop(agent, activeSession, timeoutMs, streamResponse)
    : await streamResponse(agent, activeSession, timeoutMs);

  if (state === State.RATE_LIMITED) {
    console.log(`RATE_LIMITED: ${agent.parseRetryTime(screen)}`);
    process.exit(2);
  }

  if (state === State.CONFIRMING) {
    console.log(`CONFIRM: ${formatConfirmationOutput(screen, agent)}`);
    process.exit(3);
  }
}

/**
 * @param {Agent} agent
 * @param {string | null | undefined} session
 * @param {number} [index]
 * @param {{wait?: boolean, stale?: boolean, timeoutMs?: number}} [options]
 */
async function cmdOutput(
  agent,
  session,
  index = 0,
  { wait = false, stale = false, timeoutMs } = {}
) {
  if (!session || !tmuxHasSession(session)) {
    console.log("ERROR: no session");
    process.exit(1);
  }

  let screen;
  if (wait) {
    const result = await waitUntilReady(agent, session, timeoutMs);
    screen = result.screen;
  } else {
    screen = tmuxCapture(session, 500);
  }

  const state = agent.getState(screen, session);

  if (state === State.RATE_LIMITED) {
    console.log(`RATE_LIMITED: ${agent.parseRetryTime(screen)}`);
    process.exit(2);
  }

  if (state === State.CONFIRMING) {
    console.log(`CONFIRM: ${formatConfirmationOutput(screen, agent)}`);
    process.exit(3);
  }

  if (state === State.THINKING) {
    if (!stale) {
      console.log(
        "THINKING: Use --wait to block, or --stale for old response."
      );
      process.exit(1);
    }
    // --stale: fall through to show previous response
  }

  const output = agent.getResponse(session, screen, index);
  if (output) {
    console.log(output);
  } else {
    console.log("READY_NO_CONTENT");
  }
}

/**
 * @param {Agent} agent
 * @param {string | null | undefined} session
 */
function cmdStatus(agent, session) {
  if (!session || !tmuxHasSession(session)) {
    console.log("NO_SESSION");
    process.exit(1);
  }

  const screen = tmuxCapture(session);
  const state = agent.getState(screen, session);

  if (state === State.RATE_LIMITED) {
    console.log(`RATE_LIMITED: ${agent.parseRetryTime(screen)}`);
    process.exit(2);
  }

  if (state === State.CONFIRMING) {
    console.log(`CONFIRM: ${formatConfirmationOutput(screen, agent)}`);
    process.exit(3);
  }

  if (state === State.THINKING) {
    console.log("THINKING");
    process.exit(4);
  }

  if (state === State.STARTING) {
    console.log("STARTING");
    process.exit(6);
  }

  // READY (or UPDATE_PROMPT which is transient)
  console.log("READY");
  process.exit(0);
}

/**
 * @param {Agent} agent
 * @param {string | null | undefined} session
 * @param {{scrollback?: number}} [options]
 */
function cmdDebug(agent, session, { scrollback = 0 } = {}) {
  if (!session || !tmuxHasSession(session)) {
    console.log("ERROR: no session");
    process.exit(1);
  }

  const screen = tmuxCapture(session, scrollback);
  const state = agent.getState(screen, session);

  console.log(`=== Session: ${session} ===`);
  console.log(`=== State: ${state} ===`);
  console.log(`=== Screen ===`);
  console.log(screen);
}
/**
 * @param {string} input
 * @returns {{type: 'literal' | 'key', value: string}[]}
 */
function parseKeySequence(input) {
  // Parse a string like "1[Enter]" or "[Escape]hello[C-c]" into a sequence of actions
  // [Enter], [Escape], [Up], [Down], [Tab], [C-c], etc. are special keys
  // Everything else is literal text
  /** @type {{type: 'literal' | 'key', value: string}[]} */
  const parts = [];
  let i = 0;
  let literal = "";

  while (i < input.length) {
    if (input[i] === "[") {
      // Flush any accumulated literal text
      if (literal) {
        parts.push({ type: "literal", value: literal });
        literal = "";
      }
      // Find the closing bracket
      const end = input.indexOf("]", i);
      if (end === -1) {
        // No closing bracket, treat as literal
        literal += input[i];
        i++;
      } else {
        const key = input.slice(i + 1, end);
        // Skip empty brackets, but allow any non-empty key (let tmux validate)
        if (key) {
          parts.push({ type: "key", value: key });
        }
        i = end + 1;
      }
    } else {
      literal += input[i];
      i++;
    }
  }

  // Flush remaining literal text
  if (literal) {
    parts.push({ type: "literal", value: literal });
  }

  return parts;
}

/**
 * @param {string | null | undefined} session
 * @param {string} input
 */
function cmdSend(session, input) {
  if (!session || !tmuxHasSession(session)) {
    console.log("ERROR: no session");
    process.exit(1);
  }

  const parts = parseKeySequence(input);
  for (const part of parts) {
    if (part.type === "literal") {
      tmuxSendLiteral(session, part.value);
    } else {
      tmuxSend(session, part.value);
    }
  }
}

/**
 * @param {Agent} agent
 * @param {string | null | undefined} session
 * @param {string | number} n
 * @param {{wait?: boolean, timeoutMs?: number}} [options]
 */
async function cmdSelect(agent, session, n, { wait = false, timeoutMs } = {}) {
  if (!session || !tmuxHasSession(session)) {
    console.log("ERROR: no session");
    process.exit(1);
  }

  tmuxSend(session, n.toString());

  if (!wait) return;

  const { state, screen } = await waitForResponse(agent, session, timeoutMs);

  if (state === State.RATE_LIMITED) {
    console.log(`RATE_LIMITED: ${agent.parseRetryTime(screen)}`);
    process.exit(2);
  }

  if (state === State.CONFIRMING) {
    console.log(`CONFIRM: ${formatConfirmationOutput(screen, agent)}`);
    process.exit(3);
  }

  const response = agent.getResponse(session, screen);
  console.log(response || "");
}

// =============================================================================
// CLI
// =============================================================================

/**
 * Resolve the agent to use based on (in priority order):
 * 1. Explicit --tool flag
 * 2. Session name (e.g., "claude-archangel-..." → ClaudeAgent)
 * 3. CLI invocation name (axclaude, axcodex)
 * 4. AX_DEFAULT_TOOL environment variable
 * 5. Default to CodexAgent
 *
 * @param {{toolFlag?: string, sessionName?: string | null}} options
 * @returns {{agent: Agent, error?: string}}
 */
function resolveAgent({ toolFlag, sessionName } = {}) {
  // 1. Explicit --tool flag takes highest priority
  if (toolFlag) {
    if (toolFlag === "claude") return { agent: ClaudeAgent };
    if (toolFlag === "codex") return { agent: CodexAgent };
    return { agent: CodexAgent, error: `unknown tool '${toolFlag}'` };
  }

  // 2. Infer from session name (e.g., "claude-archangel-..." or "codex-partner-...")
  if (sessionName) {
    const parsed = parseSessionName(sessionName);
    if (parsed?.tool === "claude") return { agent: ClaudeAgent };
    if (parsed?.tool === "codex") return { agent: CodexAgent };
  }

  // 3. CLI invocation name
  const invoked = path.basename(process.argv[1], ".js");
  if (invoked === "axclaude" || invoked === "claude")
    return { agent: ClaudeAgent };
  if (invoked === "axcodex" || invoked === "codex")
    return { agent: CodexAgent };

  // 4. Infer from parent process (running from within claude/codex)
  const caller = findCallerAgent();
  if (caller?.agent === "claude") return { agent: ClaudeAgent };
  if (caller?.agent === "codex") return { agent: CodexAgent };

  // 5. AX_DEFAULT_TOOL environment variable
  const defaultTool = process.env.AX_DEFAULT_TOOL;
  if (defaultTool === "claude") return { agent: ClaudeAgent };
  if (defaultTool === "codex" || !defaultTool) return { agent: CodexAgent };

  console.error(
    `WARNING: invalid AX_DEFAULT_TOOL="${defaultTool}", using codex`
  );
  return { agent: CodexAgent };
}

/**
 * @param {Agent} agent
 * @param {string} cliName
 */
function printHelp(agent, cliName) {
  const name = cliName;
  const backendName = agent.displayName;

  console.log(`${name} v${VERSION} - agentic assistant CLI (${backendName})

Usage: ${name} [OPTIONS] <command|message> [ARGS...]

Messaging:
  <message>                 Send message to ${name}
  review [TYPE] [TARGET]    Review code: uncommitted, branch [base], commit [ref], custom
  do <prompt>               Run one iteration (auto-approves by default)
                            Options: --name=NAME, --loop, --max-loops=N, --reset

Sessions:
  compact                   Summarise session to shrink context size
  reset                     Start fresh conversation
  agents                    List all running agents
  target                    Show default target session for current tool
  attach [SESSION]          Attach to agent session interactively
  kill                      Kill sessions (--all, --session=NAME, --orphans [--force])

Archangels:
  summon [name]             Summon archangels (all, or by name)
  recall [name]             Recall archangels (all, or by name)
  mailbox                   Archangel notes (filters: --branch=git, --all)
  rfp <prompt>              Request proposals (--archangels=a,b)
  rfp wait <id>             Wait for proposals (--archangels=a,b)

Recovery/State:
  status                    Exit code: ready=0 rate_limit=2 confirm=3 thinking=4 starting=6
  output [-N]               Show response (0=last, -1=prev, -2=older)
  debug [SESSION]           Show raw screen output and detected state
  approve                   Approve pending action (send 'y')
  reject                    Reject pending action (send 'n')
  select N                  Select menu option N
  send KEYS                 Send key sequence (e.g. "1[Enter]", "[Escape]")
  log [SESSION]             View conversation log (--tail=N, --follow, --reasoning)

Flags:
  --tool=NAME               Select agent (aliases: axclaude, axcodex)
  --session=ID              name | archangel | uuid-prefix | self
  --fresh                   Reset conversation before review
  --yolo                    Skip all confirmations (dangerous)
  --auto-approve=TOOLS      Auto-approve specific tools (e.g. 'Bash("cargo *")')
  --wait                    Wait for response (default for messages; required for approve/reject)
  --no-wait                 Fire-and-forget: send message, print session ID, exit immediately
  --timeout=N               Set timeout in seconds (default: ${
    DEFAULT_TIMEOUT_MS / 1000
  }, reviews: ${REVIEW_TIMEOUT_MS / 1000})

Examples:
  ${name} "explain this codebase"
  ${name} "review the error handling"                   # Auto custom review (${
    REVIEW_TIMEOUT_MS / 60000
  }min timeout)
  ${name} "FYI: auth was refactored" --no-wait          # Send context to a working session (no response needed)
  ${name} --auto-approve='Bash("cargo *")' "run tests"  # Session with specific permissions
  ${name} review uncommitted --wait
  ${name} review branch main                            # Review changes vs main branch
  ${name} review commit HEAD~1                          # Review specific commit
  ${name} kill                                          # Kill agents in current project
  ${name} kill --all                                    # Kill all agents across all projects
  ${name} kill --session=NAME                           # Kill specific session
  ${name} summon                                        # Summon all archangels from .ai/agents/*.md
  ${name} summon reviewer                               # Summon by name (creates config if new)
  ${name} recall                                        # Recall all archangels
  ${name} recall reviewer                               # Recall one by name
  ${name} agents                                        # List all agents (shows TYPE=archangel)

Note: Reviews and complex tasks may take several minutes.
      Use Bash run_in_background for long operations (not --no-wait).`);
}

async function main() {
  // Check tmux is installed
  const tmuxCheck = spawnSync("tmux", ["-V"], { encoding: "utf-8" });
  if (tmuxCheck.error || tmuxCheck.status !== 0) {
    console.error("ERROR: tmux is not installed or not in PATH");
    console.error(
      "Install with: brew install tmux (macOS) or apt install tmux (Linux)"
    );
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const cliName = path.basename(process.argv[1], ".js");

  // Parse all flags and positionals in one place
  const { flags, positionals } = parseCliArgs(args);

  // Support `ax codex "prompt"` and `ax claude "prompt"` as shorthand for --tool
  if (
    (positionals[0] === "codex" || positionals[0] === "claude") &&
    !flags.tool
  ) {
    const tool = positionals.shift();
    flags.tool = tool;
    console.error(
      styleText("yellow", `Hint: use 'ax${tool}' or 'ax --tool=${tool}' instead`)
    );
  }

  // Skip "ask" if present (e.g., `ax ask "prompt"` or `ax codex ask "prompt"`)
  if (positionals[0] === "ask" && positionals.length > 1) {
    positionals.shift();
    console.error(
      styleText("yellow", `Hint: 'ask' is not needed, just use 'ax "prompt"'`)
    );
  }

  if (flags.version) {
    console.log(VERSION);
    process.exit(0);
  }

  // Extract flags into local variables for convenience
  const {
    wait,
    noWait,
    yolo,
    fresh,
    reasoning,
    follow,
    all,
    orphans,
    force,
    stale,
    autoApprove,
  } = flags;

  // Session resolution (must happen before agent resolution so we can infer tool from session name)
  let session = null;
  if (flags.session) {
    if (flags.session === "self") {
      const current = tmuxCurrentSession();
      if (!current) {
        console.log("ERROR: --session=self requires running inside tmux");
        process.exit(1);
      }
      session = current;
    } else {
      // Resolve partial names, archangel names, and UUID prefixes
      session = resolveSessionName(flags.session);
    }
  }

  // Agent resolution (considers --tool flag, session name, invocation, and env vars)
  const { agent, error: agentError } = resolveAgent({
    toolFlag: flags.tool,
    sessionName: session,
  });
  if (agentError) {
    console.log(`ERROR: ${agentError}`);
    process.exit(1);
  }

  // Validate --auto-approve is only used with Claude (Codex doesn't support --allowedTools)
  if (autoApprove && agent.name === "codex") {
    console.log(
      "ERROR: --auto-approve is not supported by Codex. Use --yolo instead."
    );
    process.exit(1);
  }

  // If no explicit session, use agent's default (with permission filtering)
  if (!session) {
    session = agent.getDefaultSession({ allowedTools: autoApprove, yolo });
  }

  // Timeout (convert seconds to milliseconds)
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (flags.timeout !== undefined) {
    if (isNaN(flags.timeout) || flags.timeout <= 0) {
      console.log("ERROR: invalid timeout");
      process.exit(1);
    }
    timeoutMs = flags.timeout * 1000;
  }

  // Tail (for log command)
  const tail = flags.tail ?? 50;

  // Limit (for mailbox command)
  const limit = flags.limit ?? 20;

  // Branch filter (for mailbox command)
  const branch = flags.branch ?? null;

  // Command is first positional
  const cmd = positionals[0];

  // Dispatch commands
  if (cmd === "agents" || cmd === "list") return cmdAgents();
  if (cmd === "target") {
    const defaultSession = agent.getDefaultSession({
      allowedTools: autoApprove,
      yolo,
    });
    if (defaultSession) {
      console.log(defaultSession);
    } else {
      console.log("NO_TARGET");
      process.exit(1);
    }
    return;
  }
  if (cmd === "summon") return cmdSummon(positionals[1]);
  if (cmd === "recall") return cmdRecall(positionals[1]);
  if (cmd === "archangel") return cmdArchangel(positionals[1]);
  if (cmd === "kill") return cmdKill(session, { all, orphans, force });
  if (cmd === "attach") {
    const attachSession = positionals[1]
      ? resolveSessionName(positionals[1])
      : session;
    return cmdAttach(attachSession);
  }
  if (cmd === "log") {
    const logSession = positionals[1]
      ? resolveSessionName(positionals[1])
      : session;
    return cmdLog(logSession, { tail, reasoning, follow });
  }
  if (cmd === "mailbox") return cmdMailbox({ limit, branch, all });
  if (cmd === "rfp") {
    if (positionals[1] === "wait") {
      const rfpId = positionals[2];
      if (!rfpId) {
        console.log("ERROR: missing rfp id");
        process.exit(1);
      }
      return cmdRfpWait(rfpId, { archangels: flags.archangels, timeoutMs });
    }
    const rawPrompt = positionals.slice(1).join(" ");
    const prompt = await readStdinIfNeeded(rawPrompt);
    if (!prompt) {
      console.log("ERROR: missing prompt for rfp");
      process.exit(1);
    }
    return cmdRfp(prompt, { archangels: flags.archangels, fresh, noWait });
  }
  if (cmd === "do") {
    const rawPrompt = positionals.slice(1).join(" ");
    const prompt = await readStdinIfNeeded(rawPrompt);
    if (!prompt) {
      console.log("ERROR: no prompt provided");
      process.exit(1);
    }
    return cmdDo(agent, prompt, {
      name: flags.name || "default",
      maxLoops: flags.maxLoops || 10,
      loop: flags.loop,
      reset: flags.reset,
      session: flags.session ? session : null,
      timeoutMs,
    });
  }
  if (cmd === "approve") return cmdApprove(agent, session, { wait, timeoutMs });
  if (cmd === "reject") return cmdReject(agent, session, { wait, timeoutMs });
  if (cmd === "review") {
    const customInstructions = await readStdinIfNeeded(positionals[2]);
    return cmdReview(
      agent,
      session,
      positionals[1],
      customInstructions ?? undefined,
      {
        wait: !noWait,
        fresh,
        timeoutMs: flags.timeout !== undefined ? timeoutMs : REVIEW_TIMEOUT_MS,
      }
    );
  }
  if (cmd === "status") return cmdStatus(agent, session);
  if (cmd === "debug") {
    const debugSession = positionals[1]
      ? resolveSessionName(positionals[1])
      : session;
    return cmdDebug(agent, debugSession);
  }
  if (cmd === "output") {
    const indexArg = positionals[1];
    const index = indexArg?.startsWith("-") ? parseInt(indexArg, 10) : 0;
    return cmdOutput(agent, session, index, { wait, stale, timeoutMs });
  }
  if (cmd === "send" && positionals.length > 1)
    return cmdSend(session, positionals.slice(1).join(" "));
  if (cmd === "compact")
    return cmdAsk(agent, session, "/compact", { noWait: true, timeoutMs });
  if (cmd === "reset") {
    // Send /new and wait for completion
    await cmdAsk(agent, session, "/new", { timeoutMs });

    // Find the newest session UUID and rename tmux session to match
    if (session && agent.name === "claude") {
      const newUuid = findNewestClaudeSessionUuid(session);
      if (newUuid) {
        const newName = rebuildSessionName(session, newUuid);
        if (newName && newName !== session) {
          tmuxRenameSession(session, newName);
          console.log(`Session: ${newName}`);
        }
      }
    }
    return;
  }
  if (cmd === "select" && positionals[1])
    return cmdSelect(agent, session, positionals[1], { wait, timeoutMs });

  // Default: send message
  const rawMessage = positionals.join(" ");
  let message = await readStdinIfNeeded(rawMessage);

  if (!message || flags.help) {
    printHelp(agent, cliName);
    process.exit(0);
  }
  const messageText = message;

  // Detect "review ..." or "please review ..." and route to custom review mode
  const reviewMatch = messageText.match(/^(?:please )?review\s*(.*)/i);
  if (reviewMatch && agent.reviewOptions) {
    const customInstructions = reviewMatch[1].trim() || null;
    return cmdReview(agent, session, "custom", customInstructions, {
      wait: !noWait,
      yolo,
      timeoutMs: flags.timeout !== undefined ? timeoutMs : REVIEW_TIMEOUT_MS,
    });
  }

  return cmdAsk(agent, session, messageText, {
    noWait,
    yolo,
    allowedTools: autoApprove,
    timeoutMs,
  });
}

// Run main() only when executed directly (not when imported for testing)
// Use realpathSync to handle symlinks (e.g., axclaude, axcodex bin entries)
const isDirectRun =
  process.argv[1] &&
  (() => {
    try {
      return realpathSync(process.argv[1]) === __filename;
    } catch {
      return false;
    }
  })();
if (isDirectRun) {
  main().catch((err) => {
    console.log(`ERROR: ${err.message}`);
    if (err instanceof TimeoutError && err.session) {
      console.log(
        `Hint: Use 'ax debug --session=${err.session}' to see current screen state`
      );
    }
    process.exit(1);
  });
}

// Exports for testing (pure functions only)
export {
  parseSessionName,
  parseAgentConfig,
  parseKeySequence,
  parseCliArgs,
  getClaudeProjectPath,
  matchesPattern,
  getBaseDir,
  truncate,
  truncateDiff,
  extractTextContent,
  extractToolCalls,
  extractThinking,
  detectState,
  State,
  normalizeAllowedTools,
  computePermissionHash,
  formatClaudeLogEntry,
  formatCodexLogEntry,
  // Terminal stream primitives
  parseJsonlEntry,
  parseScreenLines,
  parseAnsiLine,
  parseStyledScreenLines,
  findMatch,
  // Terminal stream implementations
  JsonlTerminalStream,
  ScreenTerminalStream,
  StyledScreenTerminalStream,
  FakeTerminalStream,
  CodexAgent,
  ClaudeAgent,
};
