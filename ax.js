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
} from "node:fs";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageJson = JSON.parse(readFileSync(path.join(__dirname, "package.json"), "utf-8"));
const VERSION = packageJson.version;

/**
 * @typedef {'claude' | 'codex'} ToolName
 */

/**
 * @typedef {Object} ParsedSession
 * @property {string} tool
 * @property {string} [archangelName]
 * @property {string} [uuid]
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
 * @property {{UserPromptSubmit?: ClaudeHookEntry[], PostToolUse?: ClaudeHookEntry[], Stop?: ClaudeHookEntry[], [key: string]: ClaudeHookEntry[] | undefined}} [hooks]
 */

const DEBUG = process.env.AX_DEBUG === "1";

/**
 * @param {string} context
 * @param {unknown} err
 */
function debugError(context, err) {
  if (DEBUG) console.error(`[debug:${context}]`, err instanceof Error ? err.message : err);
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
 * @returns {string}
 */
function tmuxCapture(session, scrollback = 0) {
  try {
    const args = ["capture-pane", "-t", session, "-p"];
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
  tmux(["send-keys", "-t", session, keys]);
}

/**
 * @param {string} session
 * @param {string} text
 */
function tmuxSendLiteral(session, text) {
  tmux(["send-keys", "-t", session, "-l", text]);
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
 * @param {string} session
 * @param {string} command
 */
function tmuxNewSession(session, command) {
  // Use spawnSync to avoid command injection via session/command
  const result = spawnSync("tmux", ["new-session", "-d", "-s", session, command], {
    encoding: "utf-8",
  });
  if (result.status !== 0) throw new Error(result.stderr || "tmux new-session failed");
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
 * Check if a session was started in yolo mode by inspecting the pane's start command.
 * @param {string} session
 * @returns {boolean}
 */
function isYoloSession(session) {
  try {
    const result = spawnSync(
      "tmux",
      ["display-message", "-t", session, "-p", "#{pane_start_command}"],
      {
        encoding: "utf-8",
      },
    );
    if (result.status !== 0) return false;
    const cmd = result.stdout.trim();
    return cmd.includes("--dangerously-");
  } catch {
    return false;
  }
}

// =============================================================================
// Helpers - timing
// =============================================================================

/** @param {number} ms */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const POLL_MS = parseInt(process.env.AX_POLL_MS || "200", 10);
const DEFAULT_TIMEOUT_MS = parseInt(process.env.AX_TIMEOUT_MS || "120000", 10);
const REVIEW_TIMEOUT_MS = parseInt(process.env.AX_REVIEW_TIMEOUT_MS || "900000", 10); // 15 minutes
const STARTUP_TIMEOUT_MS = parseInt(process.env.AX_STARTUP_TIMEOUT_MS || "30000", 10);
const ARCHANGEL_STARTUP_TIMEOUT_MS = parseInt(
  process.env.AX_ARCHANGEL_STARTUP_TIMEOUT_MS || "60000",
  10,
);
const ARCHANGEL_RESPONSE_TIMEOUT_MS = parseInt(
  process.env.AX_ARCHANGEL_RESPONSE_TIMEOUT_MS || "300000",
  10,
); // 5 minutes
const ARCHANGEL_HEALTH_CHECK_MS = parseInt(process.env.AX_ARCHANGEL_HEALTH_CHECK_MS || "30000", 10);
const STABLE_MS = parseInt(process.env.AX_STABLE_MS || "1000", 10);
const APPROVE_DELAY_MS = parseInt(process.env.AX_APPROVE_DELAY_MS || "100", 10);
const MAILBOX_MAX_AGE_MS = parseInt(process.env.AX_MAILBOX_MAX_AGE_MS || "3600000", 10); // 1 hour
const CLAUDE_CONFIG_DIR = process.env.AX_CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
const CODEX_CONFIG_DIR = process.env.AX_CODEX_CONFIG_DIR || path.join(os.homedir(), ".codex");
const TRUNCATE_USER_LEN = 500;
const TRUNCATE_THINKING_LEN = 300;
const ARCHANGEL_GIT_CONTEXT_HOURS = 4;
const ARCHANGEL_GIT_CONTEXT_MAX_LINES = 200;
const ARCHANGEL_PARENT_CONTEXT_ENTRIES = 10;

/**
 * @param {string} session
 * @param {(screen: string) => boolean} predicate
 * @param {number} [timeoutMs]
 * @returns {Promise<string>}
 */
async function waitFor(session, predicate, timeoutMs = STARTUP_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const screen = tmuxCapture(session);
    if (predicate(screen)) return screen;
    await sleep(POLL_MS);
  }
  throw new Error("timeout");
}

// =============================================================================
// Helpers - process
// =============================================================================

/**
 * @returns {number | null}
 */
function findCallerPid() {
  let pid = process.ppid;
  while (pid > 1) {
    const result = spawnSync("ps", ["-p", pid.toString(), "-o", "ppid=,comm="], {
      encoding: "utf-8",
    });
    if (result.status !== 0) break;
    const parts = result.stdout.trim().split(/\s+/);
    const ppid = parseInt(parts[0], 10);
    const cmd = parts.slice(1).join(" ");
    if (cmd.includes("claude") || cmd.includes("codex")) {
      return pid;
    }
    pid = ppid;
  }
  return null;
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
 * @property {boolean} version
 * @property {boolean} help
 * @property {string} [tool]
 * @property {string} [session]
 * @property {number} [timeout]
 * @property {number} [tail]
 * @property {number} [limit]
 * @property {string} [branch]
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
      version: { type: "boolean", short: "V", default: false },
      help: { type: "boolean", short: "h", default: false },
      // Value flags
      tool: { type: "string" },
      session: { type: "string" },
      timeout: { type: "string" },
      tail: { type: "string" },
      limit: { type: "string" },
      branch: { type: "string" },
    },
    allowPositionals: true,
    strict: false, // Don't error on unknown flags
  });

  return {
    flags: {
      wait: values.wait,
      noWait: values["no-wait"],
      yolo: values.yolo,
      fresh: values.fresh,
      reasoning: values.reasoning,
      follow: values.follow,
      all: values.all,
      version: values.version,
      help: values.help,
      tool: values.tool,
      session: values.session,
      timeout: values.timeout !== undefined ? Number(values.timeout) : undefined,
      tail: values.tail !== undefined ? Number(values.tail) : undefined,
      limit: values.limit !== undefined ? Number(values.limit) : undefined,
      branch: values.branch,
    },
    positionals,
  };
}

// Helpers - session tracking
// =============================================================================

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
  const archangelMatch = rest.match(
    /^archangel-(.+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (archangelMatch) {
    return { tool, archangelName: archangelMatch[1], uuid: archangelMatch[2] };
  }

  // Partner: {tool}-partner-{uuid}
  const partnerMatch = rest.match(
    /^partner-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i,
  );
  if (partnerMatch) {
    return { tool, uuid: partnerMatch[1] };
  }

  // Anything else
  return { tool };
}

/**
 * @param {string} tool
 * @returns {string}
 */
function generateSessionName(tool) {
  return `${tool}-partner-${randomUUID()}`;
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
      },
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
  const claudeProjectDir = path.join(CLAUDE_CONFIG_DIR, "projects", projectPath);

  // Check sessions-index.json first
  const indexPath = path.join(claudeProjectDir, "sessions-index.json");
  if (existsSync(indexPath)) {
    try {
      const index = JSON.parse(readFileSync(indexPath, "utf-8"));
      const entry = index.entries?.find(
        /** @param {{sessionId: string, fullPath?: string}} e */ (e) => e.sessionId === sessionId,
      );
      if (entry?.fullPath) return entry.fullPath;
    } catch (err) {
      debugError("findClaudeLogPath", err);
    }
  }

  // Fallback: direct path
  const directPath = path.join(claudeProjectDir, `${sessionId}.jsonl`);
  if (existsSync(directPath)) return directPath;

  return null;
}

/**
 * @param {string} sessionName
 * @returns {string | null}
 */
function findCodexLogPath(sessionName) {
  // For Codex, we need to match by timing since we can't control the session ID
  // Get tmux session creation time
  try {
    const result = spawnSync(
      "tmux",
      ["display-message", "-t", sessionName, "-p", "#{session_created}"],
      {
        encoding: "utf-8",
      },
    );
    if (result.status !== 0) return null;
    const createdTs = parseInt(result.stdout.trim(), 10) * 1000; // tmux gives seconds, we need ms
    if (isNaN(createdTs)) return null;

    // Codex stores sessions in ~/.codex/sessions/YYYY/MM/DD/rollout-TIMESTAMP-UUID.jsonl
    const sessionsDir = path.join(CODEX_CONFIG_DIR, "sessions");
    if (!existsSync(sessionsDir)) return null;

    const startDate = new Date(createdTs);
    const year = startDate.getFullYear().toString();
    const month = String(startDate.getMonth() + 1).padStart(2, "0");
    const day = String(startDate.getDate()).padStart(2, "0");

    const dayDir = path.join(sessionsDir, year, month, day);
    if (!existsSync(dayDir)) return null;

    // Find the closest log file created after the tmux session started
    // Use 60-second window to handle slow startups (model download, first run, heavy load)
    const files = readdirSync(dayDir).filter((f) => f.endsWith(".jsonl"));
    const candidates = [];

    for (const file of files) {
      // Parse timestamp from filename: rollout-2026-01-22T13-05-15-UUID.jsonl
      const match = file.match(/^rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-/);
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

    if (candidates.length === 0) return null;
    // Return the closest match
    candidates.sort((a, b) => a.diff - b.diff);
    return candidates[0].path;
  } catch {
    return null;
  }
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

    for (let i = lines.length - 1; i >= 0 && assistantTexts.length < needed; i--) {
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

  // Exact match
  if (agentSessions.includes(partial)) return partial;

  // Archangel name match (e.g., "reviewer" matches "claude-archangel-reviewer-uuid")
  const archangelMatches = agentSessions.filter((s) => {
    const parsed = parseSessionName(s);
    return parsed?.archangelName === partial;
  });
  if (archangelMatches.length === 1) return archangelMatches[0];
  if (archangelMatches.length > 1) {
    console.log("ERROR: ambiguous archangel name. Matches:");
    for (const m of archangelMatches) console.log(`  ${m}`);
    process.exit(1);
  }

  // Prefix match
  const matches = agentSessions.filter((s) => s.startsWith(partial));
  if (matches.length === 1) return matches[0];
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
  if (uuidMatches.length === 1) return uuidMatches[0];
  if (uuidMatches.length > 1) {
    console.log("ERROR: ambiguous UUID prefix. Matches:");
    for (const m of uuidMatches) console.log(`  ${m}`);
    process.exit(1);
  }

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
      console.error(`ERROR: Failed to read ${file}: ${err instanceof Error ? err.message : err}`);
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
  const frontmatterMatch = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
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
  const fieldLines = frontmatter.split("\n").filter((line) => /^\w+:/.test(line.trim()));
  for (const line of fieldLines) {
    const fieldName = line.trim().match(/^(\w+):/)?.[1];
    if (fieldName && !knownFields.includes(fieldName)) {
      // Suggest closest match
      const suggestions = knownFields.filter(
        (f) => f[0] === fieldName[0] || fieldName.includes(f.slice(0, 3)),
      );
      const hint = suggestions.length > 0 ? ` Did you mean '${suggestions[0]}'?` : "";
      return {
        error: `Unknown field '${fieldName}'.${hint} Valid fields: ${knownFields.join(", ")}`,
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
    watchPatterns = inner.split(",").map((p) => p.trim().replace(/^["']|["']$/g, ""));
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
 * @param {MailboxPayload} payload
 * @returns {void}
 */
function writeToMailbox(payload) {
  ensureMailboxDir();
  const entry = {
    timestamp: new Date().toISOString(),
    type: "observation",
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
function readMailbox({ maxAge = MAILBOX_MAX_AGE_MS, branch = null, limit = 10 } = {}) {
  if (!existsSync(MAILBOX_PATH)) return [];

  const now = Date.now();
  const lines = readFileSync(MAILBOX_PATH, "utf-8").trim().split("\n").filter(Boolean);
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
  const lines = readFileSync(MAILBOX_PATH, "utf-8").trim().split("\n").filter(Boolean);
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
    const commits = execSync(`git log ${mainBranch}..HEAD ${since} --oneline 2>/dev/null`, {
      encoding: "utf-8",
    }).trim();

    if (!commits) return "";

    // Get diff for those commits
    const firstCommit = commits.split("\n").filter(Boolean).pop()?.split(" ")[0];
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
    sections.push("## Staged Changes (about to be committed)\n```diff\n" + staged + "\n```");
  }

  const uncommitted = truncateDiff(getUncommittedDiff(), maxLinesPerSection);
  if (uncommitted) {
    sections.push("## Uncommitted Changes (work in progress)\n```diff\n" + uncommitted + "\n```");
  }

  const recent = truncateDiff(getRecentCommitsDiff(hoursAgo), maxLinesPerSection);
  if (recent) {
    sections.push(`## Recent Commits (last ${hoursAgo} hours)\n\`\`\`diff\n` + recent + "\n```");
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
  const callerPid = findCallerPid();
  if (!callerPid) return null; // Not running from Claude

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
  const claudeProjectDir = path.join(CLAUDE_CONFIG_DIR, "projects", projectPath);
  if (existsSync(claudeProjectDir)) {
    try {
      const files = readdirSync(claudeProjectDir).filter((f) => f.endsWith(".jsonl"));
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
          const planMatch = line.match(/\/Users\/[^"]+\/\.claude\/plans\/[^"]+\.md/);
          if (planMatch) planPath = planMatch[0];
        }

        if (entry.type === "user") {
          const c = entry.message?.content;
          // Only include user messages with actual text (not just tool results)
          if (typeof c === "string" && c.length > 10) {
            entries.push({ type: "user", text: c });
          } else if (Array.isArray(c)) {
            const text = c.find(
              /** @param {{type: string, text?: string}} x */ (x) => x.type === "text",
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
        (c.name === "Write" || c.name === "Edit"),
    );

    for (const tc of toolCalls) {
      const input = tc.input || tc.arguments || {};
      if (input.file_path === filePath || input.file_path?.endsWith("/" + filePath)) {
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
        (c.type === "tool_use" || c.type === "tool_call") && c.name === "Read",
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
        (c.name === "Write" || c.name === "Edit"),
    );
    for (const e of edits) {
      const input = e.input || e.arguments || {};
      if (input.file_path === filePath || input.file_path?.endsWith("/" + filePath)) {
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
  const userExcludePatterns = patterns.filter((p) => p.startsWith("!")).map((p) => p.slice(1));
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
      const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
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
      });
      watchers.push(watcher);
    } catch (err) {
      console.error(`Warning: Failed to watch ${dir}: ${err instanceof Error ? err.message : err}`);
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
};

/**
 * Pure function to detect agent state from screen content.
 * @param {string} screen - The screen content to analyze
 * @param {Object} config - Agent configuration for pattern matching
 * @param {string} config.promptSymbol - Symbol indicating ready state
 * @param {string[]} [config.spinners] - Spinner characters indicating thinking
 * @param {RegExp} [config.rateLimitPattern] - Pattern for rate limit detection
 * @param {string[]} [config.thinkingPatterns] - Text patterns indicating thinking
 * @param {(string | ((lines: string) => boolean))[]} [config.confirmPatterns] - Patterns for confirmation dialogs
 * @param {{screen: string[], lastLines: string[]} | null} [config.updatePromptPatterns] - Patterns for update prompts
 * @returns {string} The detected state
 */
function detectState(screen, config) {
  if (!screen) return State.STARTING;

  const lines = screen.trim().split("\n");
  const lastLines = lines.slice(-8).join("\n");
  // Larger range for confirmation detection (catches dialogs that scrolled slightly)
  const recentLines = lines.slice(-15).join("\n");

  // Rate limited - check full screen (rate limit messages can appear anywhere)
  if (config.rateLimitPattern && config.rateLimitPattern.test(screen)) {
    return State.RATE_LIMITED;
  }

  // Thinking - spinners (full screen, they're unique UI elements)
  const spinners = config.spinners || [];
  if (spinners.some((s) => screen.includes(s))) {
    return State.THINKING;
  }
  // Thinking - text patterns (last lines)
  const thinkingPatterns = config.thinkingPatterns || [];
  if (thinkingPatterns.some((p) => lastLines.includes(p))) {
    return State.THINKING;
  }

  // Update prompt
  if (config.updatePromptPatterns) {
    const { screen: sp, lastLines: lp } = config.updatePromptPatterns;
    if (sp && sp.some((p) => screen.includes(p)) && lp && lp.some((p) => lastLines.includes(p))) {
      return State.UPDATE_PROMPT;
    }
  }

  // Confirming - check recent lines (not full screen to avoid history false positives)
  const confirmPatterns = config.confirmPatterns || [];
  for (const pattern of confirmPatterns) {
    if (typeof pattern === "function") {
      // Functions check lastLines first (most specific), then recentLines
      if (pattern(lastLines)) return State.CONFIRMING;
      if (pattern(recentLines)) return State.CONFIRMING;
    } else {
      // String patterns check recentLines (bounded range)
      if (recentLines.includes(pattern)) return State.CONFIRMING;
    }
  }

  // Ready - only if prompt symbol is visible AND not followed by pasted content
  // "[Pasted text" indicates user has pasted content and Claude is still processing
  if (lastLines.includes(config.promptSymbol)) {
    // Check if any line has the prompt followed by pasted content indicator
    const linesArray = lastLines.split("\n");
    const promptWithPaste = linesArray.some(
      (l) => l.includes(config.promptSymbol) && l.includes("[Pasted text"),
    );
    if (!promptWithPaste) {
      return State.READY;
    }
    // If prompt has pasted content, Claude is still processing - not ready yet
  }

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
 * @property {string} startCommand
 * @property {string} yoloCommand
 * @property {string} promptSymbol
 * @property {string[]} [spinners]
 * @property {RegExp} [rateLimitPattern]
 * @property {string[]} [thinkingPatterns]
 * @property {ConfirmPattern[]} [confirmPatterns]
 * @property {UpdatePromptPatterns | null} [updatePromptPatterns]
 * @property {string[]} [responseMarkers]
 * @property {string[]} [chromePatterns]
 * @property {Record<string, string> | null} [reviewOptions]
 * @property {string} envVar
 * @property {string} [approveKey]
 * @property {string} [rejectKey]
 * @property {string} [safeAllowedTools]
 */

class Agent {
  /**
   * @param {AgentConfigInput} config
   */
  constructor(config) {
    /** @type {string} */
    this.name = config.name;
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
    /** @type {string[]} */
    this.thinkingPatterns = config.thinkingPatterns || [];
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
  }

  /**
   * @param {boolean} [yolo]
   * @param {string | null} [sessionName]
   * @returns {string}
   */
  getCommand(yolo, sessionName = null) {
    let base;
    if (yolo) {
      base = this.yoloCommand;
    } else if (this.safeAllowedTools) {
      // Default: auto-approve safe read-only operations
      base = `${this.startCommand} --allowedTools "${this.safeAllowedTools}"`;
    } else {
      base = this.startCommand;
    }
    // Claude supports --session-id for deterministic session tracking
    if (this.name === "claude" && sessionName) {
      const parsed = parseSessionName(sessionName);
      if (parsed?.uuid) {
        return `${base} --session-id ${parsed.uuid}`;
      }
    }
    return base;
  }

  getDefaultSession() {
    // Check env var for explicit session
    if (this.envVar && process.env[this.envVar]) {
      return process.env[this.envVar];
    }

    const cwd = process.cwd();
    const childPattern = new RegExp(`^${this.name}-(partner-)?[0-9a-f-]{36}$`, "i");

    // If inside tmux, look for existing agent session in same cwd
    const current = tmuxCurrentSession();
    if (current) {
      const sessions = tmuxListSessions();
      const existing = sessions.find((s) => {
        if (!childPattern.test(s)) return false;
        const sessionCwd = getTmuxSessionCwd(s);
        return sessionCwd === cwd;
      });
      if (existing) return existing;
      // No existing session in this cwd - will generate new one in cmdStart
      return null;
    }

    // Walk up to find claude/codex ancestor and reuse its session (must match cwd)
    const callerPid = findCallerPid();
    if (callerPid) {
      const sessions = tmuxListSessions();
      const existing = sessions.find((s) => {
        if (!childPattern.test(s)) return false;
        const sessionCwd = getTmuxSessionCwd(s);
        return sessionCwd === cwd;
      });
      if (existing) return existing;
    }

    // No existing session found
    return null;
  }

  /**
   * @returns {string}
   */
  generateSession() {
    return generateSessionName(this.name);
  }

  /**
   * Find the log file path for a session.
   * @param {string} sessionName
   * @returns {string | null}
   */
  findLogPath(sessionName) {
    const parsed = parseSessionName(sessionName);
    if (this.name === "claude") {
      const uuid = parsed?.uuid;
      if (uuid) return findClaudeLogPath(uuid, sessionName);
    }
    if (this.name === "codex") {
      return findCodexLogPath(sessionName);
    }
    return null;
  }

  /**
   * @param {string} screen
   * @returns {string}
   */
  getState(screen) {
    return detectState(screen, {
      promptSymbol: this.promptSymbol,
      spinners: this.spinners,
      rateLimitPattern: this.rateLimitPattern,
      thinkingPatterns: this.thinkingPatterns,
      confirmPatterns: this.confirmPatterns,
      updatePromptPatterns: this.updatePromptPatterns,
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
    if (/^(Claude Code|OpenAI Codex|Opus|gpt-|model:|directory:|cwd:)/i.test(trimmed)) return true;
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
        l.startsWith(this.promptSymbol),
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
          lastPromptLine.trim() === this.promptSymbol || lastPromptLine.match(/^❯\s*$/);
        if (isEmptyPrompt) {
          // Find the previous prompt (user's input) and extract content between
          // Note: [Pasted text is Claude's truncated output indicator, NOT a prompt
          const prevPromptIdx = lines
            .slice(0, lastPromptIdx)
            .findLastIndex((/** @type {string} */ l) => l.startsWith(this.promptSymbol));
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
        .replace(/^[⏺•]\s*(Search|Read|Grep|Glob|Write|Edit|Bash)\([^)]*\).*$/gm, "")
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
  responseMarkers: ["•", "- ", "**"],
  chromePatterns: ["context left", "for shortcuts"],
  reviewOptions: { pr: "1", uncommitted: "2", commit: "3", custom: "4" },
  envVar: "AX_SESSION",
});

// =============================================================================
// ClaudeAgent
// =============================================================================

const ClaudeAgent = new Agent({
  name: "claude",
  startCommand: "claude",
  yoloCommand: "claude --dangerously-skip-permissions",
  promptSymbol: "❯",
  spinners: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  rateLimitPattern: /rate.?limit/i,
  thinkingPatterns: ["Thinking"],
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
  const initialState = agent.getState(initialScreen);

  // Already in terminal state
  if (
    initialState === State.RATE_LIMITED ||
    initialState === State.CONFIRMING ||
    initialState === State.READY
  ) {
    return { state: initialState, screen: initialScreen };
  }

  while (Date.now() - start < timeoutMs) {
    await sleep(POLL_MS);
    const screen = tmuxCapture(session);
    const state = agent.getState(screen);

    if (state === State.RATE_LIMITED || state === State.CONFIRMING || state === State.READY) {
      return { state, screen };
    }
  }
  throw new Error("timeout");
}

/**
 * Wait for agent to process a new message and respond.
 * Waits for screen activity before considering the response complete.
 * @param {Agent} agent
 * @param {string} session
 * @param {number} [timeoutMs]
 * @returns {Promise<{state: string, screen: string}>}
 */
async function waitForResponse(agent, session, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const start = Date.now();
  const initialScreen = tmuxCapture(session);

  let lastScreen = initialScreen;
  let stableAt = null;
  let sawActivity = false;

  while (Date.now() - start < timeoutMs) {
    await sleep(POLL_MS);
    const screen = tmuxCapture(session);
    const state = agent.getState(screen);

    if (state === State.RATE_LIMITED || state === State.CONFIRMING) {
      return { state, screen };
    }

    if (screen !== lastScreen) {
      lastScreen = screen;
      stableAt = Date.now();
      if (screen !== initialScreen) {
        sawActivity = true;
      }
    }

    if (sawActivity && stableAt && Date.now() - stableAt >= STABLE_MS) {
      if (state === State.READY) {
        return { state, screen };
      }
    }

    if (state === State.THINKING) {
      sawActivity = true;
    }
  }
  throw new Error("timeout");
}

/**
 * Auto-approve loop that keeps approving confirmations until the agent is ready or rate limited.
 * Used by callers to implement yolo mode on sessions not started with native --yolo.
 * @param {Agent} agent
 * @param {string} session
 * @param {number} [timeoutMs]
 * @returns {Promise<{state: string, screen: string}>}
 */
async function autoApproveLoop(agent, session, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;

    const { state, screen } = await waitForResponse(agent, session, remaining);

    if (state === State.RATE_LIMITED || state === State.READY) {
      return { state, screen };
    }

    if (state === State.CONFIRMING) {
      tmuxSend(session, agent.approveKey);
      await sleep(APPROVE_DELAY_MS);
      continue;
    }

    // Unexpected state - log and continue polling
    debugError("autoApproveLoop", new Error(`unexpected state: ${state}`));
  }

  throw new Error("timeout");
}

/**
 * @param {Agent} agent
 * @param {string | null | undefined} session
 * @param {Object} [options]
 * @param {boolean} [options.yolo]
 * @returns {Promise<string>}
 */
async function cmdStart(agent, session, { yolo = false } = {}) {
  // Generate session name if not provided
  if (!session) {
    session = agent.generateSession();
  }

  if (tmuxHasSession(session)) return session;

  // Check agent CLI is installed before trying to start
  const cliCheck = spawnSync("which", [agent.name], { encoding: "utf-8" });
  if (cliCheck.status !== 0) {
    console.error(`ERROR: ${agent.name} CLI is not installed or not in PATH`);
    process.exit(1);
  }

  const command = agent.getCommand(yolo, session);
  tmuxNewSession(session, command);

  const start = Date.now();
  while (Date.now() - start < STARTUP_TIMEOUT_MS) {
    const screen = tmuxCapture(session);
    const state = agent.getState(screen);

    if (state === State.UPDATE_PROMPT) {
      await agent.handleUpdatePrompt(session);
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
    const state = agent.getState(screen);
    const logPath = agent.findLogPath(session);
    const type = parsed.archangelName ? "archangel" : "-";
    const isDefault =
      (parsed.tool === "claude" && session === claudeDefault) ||
      (parsed.tool === "codex" && session === codexDefault);

    return {
      session,
      tool: parsed.tool,
      state: state || "unknown",
      target: isDefault ? "*" : "",
      type,
      log: logPath || "-",
    };
  });

  // Print table
  const maxSession = Math.max(7, ...agents.map((a) => a.session.length));
  const maxTool = Math.max(4, ...agents.map((a) => a.tool.length));
  const maxState = Math.max(5, ...agents.map((a) => a.state.length));
  const maxTarget = Math.max(6, ...agents.map((a) => a.target.length));
  const maxType = Math.max(4, ...agents.map((a) => a.type.length));

  console.log(
    `${"SESSION".padEnd(maxSession)}  ${"TOOL".padEnd(maxTool)}  ${"STATE".padEnd(maxState)}  ${"TARGET".padEnd(maxTarget)}  ${"TYPE".padEnd(maxType)}  LOG`,
  );
  for (const a of agents) {
    console.log(
      `${a.session.padEnd(maxSession)}  ${a.tool.padEnd(maxTool)}  ${a.state.padEnd(maxState)}  ${a.target.padEnd(maxTarget)}  ${a.type.padEnd(maxType)}  ${a.log}`,
    );
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
  console.log(
    `Summoning: ${config.name} (pid ${child.pid})${parentSession ? ` [parent: ${parentSession.session}]` : ""}`,
  );
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
      `[archangel:${agentName}] ERROR: ${agent.name} CLI is not installed or not in PATH`,
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
    const state = agent.getState(screen);

    if (state === State.UPDATE_PROMPT) {
      await agent.handleUpdatePrompt(sessionName);
      continue;
    }

    // Handle bypass permissions confirmation dialog (Claude Code shows this for --dangerously-skip-permissions)
    if (screen.includes("Bypass Permissions mode") && screen.includes("Yes, I accept")) {
      console.log(`[archangel:${agentName}] Accepting bypass permissions dialog`);
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
      const logPath = parent ? findClaudeLogPath(parent.uuid, parent.session) : null;

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
      let prompt = basePrompt;

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
            prompt += `**Errors after:** ${ctx.subsequentErrors[0].slice(0, 200)}\n`;
          }

          if (ctx.readsBefore.length > 0) {
            const reads = ctx.readsBefore.map((f) => f.split("/").pop()).join(", ");
            prompt += `**Files read before:** ${reads}\n`;
          }
        }

        prompt += "\n\n## Files Changed\n  - " + files.slice(0, 10).join("\n  - ");

        const gitContext = buildGitContext(
          ARCHANGEL_GIT_CONTEXT_HOURS,
          ARCHANGEL_GIT_CONTEXT_MAX_LINES,
        );
        if (gitContext) {
          prompt += "\n\n## Git Context\n\n" + gitContext;
        }

        prompt +=
          '\n\nReview these changes in the context of what the user is working on. Report any issues found. Keep your response concise.\nIf there are no significant issues, respond with just "No issues found."';
      } else {
        // Fallback: no JSONL context available, use conversation + git context
        const parentContext = getParentSessionContext(ARCHANGEL_PARENT_CONTEXT_ENTRIES);
        const gitContext = buildGitContext(
          ARCHANGEL_GIT_CONTEXT_HOURS,
          ARCHANGEL_GIT_CONTEXT_MAX_LINES,
        );

        if (parentContext) {
          prompt +=
            "\n\n## Main Session Context\n\nThe user is currently working on:\n\n" + parentContext;
        }

        prompt += "\n\n## Files Changed\n  - " + files.slice(0, 10).join("\n  - ");

        if (gitContext) {
          prompt += "\n\n## Git Context\n\n" + gitContext;
        }

        prompt +=
          '\n\nReview these changes in the context of what the user is working on. Report any issues found. Keep your response concise.\nIf there are no significant issues, respond with just "No issues found."';
      }

      // Check session still exists
      if (!tmuxHasSession(sessionName)) {
        console.log(`[archangel:${agentName}] Session gone, exiting`);
        process.exit(0);
      }

      // Wait for ready
      const screen = tmuxCapture(sessionName);
      const state = agent.getState(screen);

      if (state === State.RATE_LIMITED) {
        console.error(`[archangel:${agentName}] Rate limited - stopping`);
        process.exit(2);
      }

      if (state !== State.READY) {
        console.log(`[archangel:${agentName}] Agent not ready (${state}), skipping`);
        isProcessing = false;
        return;
      }

      // Send prompt
      tmuxSendLiteral(sessionName, prompt);
      await sleep(200); // Allow time for large prompts to be processed
      tmuxSend(sessionName, "Enter");
      await sleep(100); // Ensure Enter is processed

      // Wait for response
      const { state: endState, screen: afterScreen } = await waitForResponse(
        agent,
        sessionName,
        ARCHANGEL_RESPONSE_TIMEOUT_MS,
      );

      if (endState === State.RATE_LIMITED) {
        console.error(`[archangel:${agentName}] Rate limited - stopping`);
        process.exit(2);
      }

      const cleanedResponse = agent.getResponse(sessionName, afterScreen) || "";

      // Sanity check: skip garbage responses (screen scraping artifacts)
      const isGarbage =
        cleanedResponse.includes("[Pasted text") ||
        cleanedResponse.match(/^\+\d+ lines\]/) ||
        cleanedResponse.length < 20;

      if (
        cleanedResponse &&
        !isGarbage &&
        !cleanedResponse.toLowerCase().includes("no issues found")
      ) {
        writeToMailbox({
          agent: /** @type {string} */ (agentName),
          session: sessionName,
          branch: getCurrentBranch(),
          commit: getCurrentCommit(),
          files,
          message: cleanedResponse.slice(0, 1000),
        });
        console.log(`[archangel:${agentName}] Wrote observation for ${files.length} file(s)`);
      } else if (isGarbage) {
        console.log(`[archangel:${agentName}] Skipped garbage response`);
      }
    } catch (err) {
      console.error(`[archangel:${agentName}] Error:`, err instanceof Error ? err.message : err);
    }

    isProcessing = false;
  }

  function scheduleProcessChanges() {
    processChanges().catch((err) => {
      console.error(
        `[archangel:${agentName}] Unhandled error:`,
        err instanceof Error ? err.message : err,
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
        console.log("ERROR: Name must contain only letters, numbers, dashes, and underscores");
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
    console.log(`Parent session: ${parentSession.session || "(non-tmux)"} [${parentSession.uuid}]`);
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
const HOOK_SCRIPT_VERSION = "4";

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

const __dirname = dirname(fileURLToPath(import.meta.url));
const AI_DIR = join(__dirname, "..");
const DEBUG = process.env.AX_DEBUG === "1";
const MAILBOX = join(AI_DIR, "mailbox.jsonl");
const MAX_AGE_MS = 60 * 60 * 1000;

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

// NO-OP for archangel or partner sessions
if (sessionId.includes("-archangel-") || sessionId.includes("-partner-")) {
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
  } else {
    // For other hooks, just output the context
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
    "PostToolUse": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node .ai/hooks/mailbox-inject.js", "timeout": 5 }] }],
    "Stop": [{ "matcher": "", "hooks": [{ "type": "command", "command": "node .ai/hooks/mailbox-inject.js", "timeout": 5 }] }]
  }
}`);
  }
}

function ensureClaudeHookConfig() {
  const settingsDir = ".claude";
  const settingsPath = path.join(settingsDir, "settings.json");
  const hookCommand = "node .ai/hooks/mailbox-inject.js";
  const hookEvents = ["UserPromptSubmit", "PostToolUse", "Stop"];

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
          entry.hooks?.some(/** @param {{command: string}} h */ (h) => h.command === hookCommand),
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
 * @param {{all?: boolean}} [options]
 */
function cmdKill(session, { all = false } = {}) {
  // If specific session provided, kill just that one
  if (session) {
    if (!tmuxHasSession(session)) {
      console.log("ERROR: session not found");
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
      console.log(`(Use --all to kill all ${agentSessions.length} agent(s) across all projects)`);
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
    console.log("ERROR: session not found");
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
function cmdLog(sessionName, { tail = 50, reasoning = false, follow = false } = {}) {
  if (!sessionName) {
    console.log("ERROR: no session specified. Run 'agents' to list sessions.");
    process.exit(1);
  }

  // Resolve partial session name
  const resolved = resolveSessionName(sessionName);
  if (!resolved) {
    console.log("ERROR: session not found");
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
    const startIdx = isInitial ? Math.max(0, lines.length - tail) : lastLineCount;
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
        parts.push(`> *Thinking*: ${truncate(thinking, TRUNCATE_THINKING_LEN)}\n`);
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
        input.file_path || input.path || input.command?.slice(0, 30) || input.pattern || "";
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
    console.log("No mailbox entries" + (branch ? ` for branch '${branch}'` : ""));
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

    if (p.message) {
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
 * @param {Agent} agent
 * @param {string | null | undefined} session
 * @param {string} message
 * @param {{noWait?: boolean, yolo?: boolean, timeoutMs?: number}} [options]
 */
async function cmdAsk(agent, session, message, { noWait = false, yolo = false, timeoutMs } = {}) {
  const sessionExists = session != null && tmuxHasSession(session);
  const nativeYolo = sessionExists && isYoloSession(/** @type {string} */ (session));

  // Cannot use --yolo --no-wait on a safe session: we need to stay and auto-approve
  if (yolo && noWait && sessionExists && !nativeYolo) {
    console.log("ERROR: --yolo requires waiting on a session not started with --yolo");
    console.log("Restart the session with --yolo, or allow waiting for auto-approval");
    process.exit(1);
  }

  /** @type {string} */
  const activeSession = sessionExists
    ? /** @type {string} */ (session)
    : await cmdStart(agent, session, { yolo });

  tmuxSendLiteral(activeSession, message);
  await sleep(50);
  tmuxSend(activeSession, "Enter");

  if (noWait) {
    const parsed = parseSessionName(activeSession);
    const shortId = parsed?.uuid?.slice(0, 8) || activeSession;
    const cli = path.basename(process.argv[1], ".js");
    console.log(`Sent to: ${shortId}

e.g.
  ${cli} status --session=${shortId}
  ${cli} output --session=${shortId}`);
    return;
  }

  // Yolo mode on a safe session: auto-approve until done
  const useAutoApprove = yolo && !nativeYolo;

  const { state, screen } = useAutoApprove
    ? await autoApproveLoop(agent, activeSession, timeoutMs)
    : await waitForResponse(agent, activeSession, timeoutMs);

  if (state === State.RATE_LIMITED) {
    console.log(`RATE_LIMITED: ${agent.parseRetryTime(screen)}`);
    process.exit(2);
  }

  if (state === State.CONFIRMING) {
    console.log(`CONFIRM: ${agent.parseAction(screen)}`);
    process.exit(3);
  }

  const output = agent.getResponse(activeSession, screen);
  if (output) {
    console.log(output);
  }
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
  if (agent.getState(before) !== State.CONFIRMING) {
    console.log("ERROR: not confirming");
    process.exit(1);
  }

  tmuxSend(session, agent.approveKey);

  if (!wait) return;

  const { state, screen } = await waitForResponse(agent, session, timeoutMs);

  if (state === State.RATE_LIMITED) {
    console.log(`RATE_LIMITED: ${agent.parseRetryTime(screen)}`);
    process.exit(2);
  }

  if (state === State.CONFIRMING) {
    console.log(`CONFIRM: ${agent.parseAction(screen)}`);
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
  { wait = true, yolo = true, fresh = false, timeoutMs = REVIEW_TIMEOUT_MS } = {},
) {
  const sessionExists = session != null && tmuxHasSession(session);

  // Reset conversation if --fresh and session exists
  if (fresh && sessionExists) {
    tmuxSendLiteral(/** @type {string} */ (session), "/new");
    await sleep(50);
    tmuxSend(/** @type {string} */ (session), "Enter");
    await waitUntilReady(agent, /** @type {string} */ (session), STARTUP_TIMEOUT_MS);
  }

  // Claude: use prompt-based review (no /review command)
  if (!agent.reviewOptions) {
    /** @type {Record<string, string>} */
    const reviewPrompts = {
      pr: "Review the current PR.",
      uncommitted: "Review uncommitted changes.",
      commit: "Review the most recent git commit.",
      custom: customInstructions || "Review the code.",
    };
    const prompt = (option && reviewPrompts[option]) || reviewPrompts.commit;
    return cmdAsk(agent, session, prompt, { noWait: !wait, yolo, timeoutMs });
  }

  // AX_REVIEW_MODE=exec: bypass /review command, send instructions directly
  if (process.env.AX_REVIEW_MODE === "exec" && option === "custom" && customInstructions) {
    return cmdAsk(agent, session, customInstructions, {
      noWait: !wait,
      yolo,
      timeoutMs,
    });
  }
  const nativeYolo = sessionExists && isYoloSession(/** @type {string} */ (session));

  // Cannot use --yolo without --wait on a safe session: we need to stay and auto-approve
  if (yolo && !wait && sessionExists && !nativeYolo) {
    console.log("ERROR: --yolo requires waiting on a session not started with --yolo");
    console.log("Restart the session with --yolo, or allow waiting for auto-approval");
    process.exit(1);
  }

  /** @type {string} */
  const activeSession = sessionExists
    ? /** @type {string} */ (session)
    : await cmdStart(agent, session, { yolo });

  tmuxSendLiteral(activeSession, "/review");
  await sleep(50);
  tmuxSend(activeSession, "Enter");

  await waitFor(activeSession, (s) => s.includes("Select a review preset") || s.includes("review"));

  if (option) {
    const key = agent.reviewOptions[option] || option;
    tmuxSend(activeSession, key);

    if (option === "custom" && customInstructions) {
      await waitFor(activeSession, (s) => s.includes("custom") || s.includes("instructions"));
      tmuxSendLiteral(activeSession, customInstructions);
      await sleep(50);
      tmuxSend(activeSession, "Enter");
    }
  }

  if (!wait) return;

  // Yolo mode on a safe session: auto-approve until done
  const useAutoApprove = yolo && !nativeYolo;

  const { state, screen } = useAutoApprove
    ? await autoApproveLoop(agent, activeSession, timeoutMs)
    : await waitForResponse(agent, activeSession, timeoutMs);

  if (state === State.RATE_LIMITED) {
    console.log(`RATE_LIMITED: ${agent.parseRetryTime(screen)}`);
    process.exit(2);
  }

  if (state === State.CONFIRMING) {
    console.log(`CONFIRM: ${agent.parseAction(screen)}`);
    process.exit(3);
  }

  const response = agent.getResponse(activeSession, screen);
  console.log(response || "");
}

/**
 * @param {Agent} agent
 * @param {string | null | undefined} session
 * @param {number} [index]
 * @param {{wait?: boolean, timeoutMs?: number}} [options]
 */
async function cmdOutput(agent, session, index = 0, { wait = false, timeoutMs } = {}) {
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

  const state = agent.getState(screen);

  if (state === State.RATE_LIMITED) {
    console.log(`RATE_LIMITED: ${agent.parseRetryTime(screen)}`);
    process.exit(2);
  }

  if (state === State.CONFIRMING) {
    console.log(`CONFIRM: ${agent.parseAction(screen)}`);
    process.exit(3);
  }

  if (state === State.THINKING) {
    console.log("THINKING");
    process.exit(4);
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
  const state = agent.getState(screen);

  if (state === State.RATE_LIMITED) {
    console.log(`RATE_LIMITED: ${agent.parseRetryTime(screen)}`);
    process.exit(2);
  }

  if (state === State.CONFIRMING) {
    console.log(`CONFIRM: ${agent.parseAction(screen)}`);
    process.exit(3);
  }

  if (state === State.THINKING) {
    console.log("THINKING");
    process.exit(4);
  }

  // READY (or STARTING/UPDATE_PROMPT which are transient)
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
  const state = agent.getState(screen);

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
    console.log(`CONFIRM: ${agent.parseAction(screen)}`);
    process.exit(3);
  }

  const response = agent.getResponse(session, screen);
  console.log(response || "");
}

// =============================================================================
// CLI
// =============================================================================

/**
 * @returns {Agent}
 */
function getAgentFromInvocation() {
  const invoked = path.basename(process.argv[1], ".js");
  if (invoked === "axclaude" || invoked === "claude") return ClaudeAgent;
  if (invoked === "axcodex" || invoked === "codex") return CodexAgent;

  // Default based on AX_DEFAULT_TOOL env var, or codex if not set
  const defaultTool = process.env.AX_DEFAULT_TOOL;
  if (defaultTool === "claude") return ClaudeAgent;
  if (defaultTool === "codex" || !defaultTool) return CodexAgent;

  console.error(`WARNING: invalid AX_DEFAULT_TOOL="${defaultTool}", using codex`);
  return CodexAgent;
}

/**
 * @param {Agent} agent
 * @param {string} cliName
 */
function printHelp(agent, cliName) {
  const name = cliName;
  const backendName = agent.name === "codex" ? "Codex" : "Claude";
  const hasReview = !!agent.reviewOptions;

  console.log(`${name} v${VERSION} - agentic assistant CLI (${backendName})

Usage: ${name} [OPTIONS] <command|message> [ARGS...]

Commands:
  agents                    List all running agents with state and log paths
  target                    Show default target session for current tool
  attach [SESSION]          Attach to agent session interactively
  log SESSION               View conversation log (--tail=N, --follow, --reasoning)
  mailbox                   View archangel observations (--limit=N, --branch=X, --all)
  summon [name]             Summon archangels (all, or by name)
  recall [name]             Recall archangels (all, or by name)
  kill                      Kill sessions in current project (--all for all, --session=NAME for one)
  status                    Check state (exit: 0=ready, 2=rate_limited, 3=confirming, 4=thinking)
  output [-N]               Show response (0=last, -1=prev, -2=older)
  debug                     Show raw screen output and detected state${
    hasReview
      ? `
  review [TYPE]             Review code: pr, uncommitted, commit, custom`
      : ""
  }
  select N                  Select menu option N
  approve                   Approve pending action (send 'y')
  reject                    Reject pending action (send 'n')
  send KEYS                 Send key sequence (e.g. "1[Enter]", "[Escape]")
  compact                   Summarize conversation (when context is full)
  reset                     Start fresh conversation
  <message>                 Send message to ${name}

Flags:
  --tool=NAME               Use specific agent (codex, claude)
  --session=NAME            Target session by name, archangel name, or UUID prefix (self = current)
  --wait                    Wait for response (for review, approve, etc)
  --no-wait                 Don't wait (for messages, which wait by default)
  --timeout=N               Set timeout in seconds (default: ${DEFAULT_TIMEOUT_MS / 1000}, reviews: ${REVIEW_TIMEOUT_MS / 1000})
  --yolo                    Skip all confirmations (dangerous)
  --fresh                   Reset conversation before review

Environment:
  AX_DEFAULT_TOOL           Default agent when using 'ax' (claude or codex, default: codex)
  ${agent.envVar}           Override default session name
  AX_CLAUDE_CONFIG_DIR      Override Claude config directory (default: ~/.claude)
  AX_CODEX_CONFIG_DIR       Override Codex config directory (default: ~/.codex)
  AX_REVIEW_MODE=exec       Bypass /review, send instructions directly (codex only)
  AX_DEBUG=1                Enable debug logging

Examples:
  ${name} "explain this codebase"
  ${name} "review the error handling"           # Auto custom review (${REVIEW_TIMEOUT_MS / 60000}min timeout)
  ${name} review uncommitted --wait
  ${name} approve --wait
  ${name} kill                                 # Kill agents in current project
  ${name} kill --all                           # Kill all agents across all projects
  ${name} kill --session=NAME                  # Kill specific session
  ${name} send "1[Enter]"                      # Recovery: select option 1 and press Enter
  ${name} send "[Escape][Escape]"              # Recovery: escape out of a dialog
  ${name} summon                               # Summon all archangels from .ai/agents/*.md
  ${name} summon reviewer                      # Summon by name (creates config if new)
  ${name} recall                               # Recall all archangels
  ${name} recall reviewer                      # Recall one by name
  ${name} agents                               # List all agents (shows TYPE=archangel)`);
}

async function main() {
  // Check tmux is installed
  const tmuxCheck = spawnSync("tmux", ["-V"], { encoding: "utf-8" });
  if (tmuxCheck.error || tmuxCheck.status !== 0) {
    console.error("ERROR: tmux is not installed or not in PATH");
    console.error("Install with: brew install tmux (macOS) or apt install tmux (Linux)");
    process.exit(1);
  }

  const args = process.argv.slice(2);
  const cliName = path.basename(process.argv[1], ".js");

  // Parse all flags and positionals in one place
  const { flags, positionals } = parseCliArgs(args);

  if (flags.version) {
    console.log(VERSION);
    process.exit(0);
  }

  // Extract flags into local variables for convenience
  const { wait, noWait, yolo, fresh, reasoning, follow, all } = flags;

  // Agent selection
  let agent = getAgentFromInvocation();
  if (flags.tool) {
    if (flags.tool === "claude") agent = ClaudeAgent;
    else if (flags.tool === "codex") agent = CodexAgent;
    else {
      console.log(`ERROR: unknown tool '${flags.tool}'`);
      process.exit(1);
    }
  }

  // Session resolution
  let session = agent.getDefaultSession();
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
  if (cmd === "agents") return cmdAgents();
  if (cmd === "target") {
    const defaultSession = agent.getDefaultSession();
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
  if (cmd === "kill") return cmdKill(session, { all });
  if (cmd === "attach") return cmdAttach(positionals[1] || session);
  if (cmd === "log") return cmdLog(positionals[1] || session, { tail, reasoning, follow });
  if (cmd === "mailbox") return cmdMailbox({ limit, branch, all });
  if (cmd === "approve") return cmdApprove(agent, session, { wait, timeoutMs });
  if (cmd === "reject") return cmdReject(agent, session, { wait, timeoutMs });
  if (cmd === "review")
    return cmdReview(agent, session, positionals[1], positionals[2], {
      wait,
      yolo,
      fresh,
      timeoutMs,
    });
  if (cmd === "status") return cmdStatus(agent, session);
  if (cmd === "debug") return cmdDebug(agent, session);
  if (cmd === "output") {
    const indexArg = positionals[1];
    const index = indexArg?.startsWith("-") ? parseInt(indexArg, 10) : 0;
    return cmdOutput(agent, session, index, { wait, timeoutMs });
  }
  if (cmd === "send" && positionals.length > 1)
    return cmdSend(session, positionals.slice(1).join(" "));
  if (cmd === "compact") return cmdAsk(agent, session, "/compact", { noWait: true, timeoutMs });
  if (cmd === "reset") return cmdAsk(agent, session, "/new", { noWait: true, timeoutMs });
  if (cmd === "select" && positionals[1])
    return cmdSelect(agent, session, positionals[1], { wait, timeoutMs });

  // Default: send message
  let message = positionals.join(" ");
  if (!message && hasStdinData()) {
    message = await readStdin();
  }

  if (!message || flags.help) {
    printHelp(agent, cliName);
    process.exit(0);
  }

  // Detect "review ..." or "please review ..." and route to custom review mode
  const reviewMatch = message.match(/^(?:please )?review\s*(.*)/i);
  if (reviewMatch && agent.reviewOptions) {
    const customInstructions = reviewMatch[1].trim() || null;
    return cmdReview(agent, session, "custom", customInstructions, {
      wait: !noWait,
      yolo,
      timeoutMs: flags.timeout !== undefined ? timeoutMs : REVIEW_TIMEOUT_MS,
    });
  }

  return cmdAsk(agent, session, message, { noWait, yolo, timeoutMs });
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
};
