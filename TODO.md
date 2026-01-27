# ax-agents: Bug Fixes and DX Improvements

## Critical Bugs

### 1. `--no-wait` provides no feedback (P0)

**File:** `ax.js:3226`

**Problem:** When using `--no-wait`, the function returns silently. User has no idea:
- Which session received the message
- Whether it worked
- How to check the result

```javascript
if (noWait) return;  // Silent return, no feedback
```

**Fix:** Print the session ID and a polling command:
```javascript
if (noWait) {
  const shortId = activeSession.split('-').pop().slice(0,8);
  console.log(`Sent to: ${activeSession}`);
  console.log(`Poll: ax status --session=${shortId} && ax output --session=${shortId}`);
  return;
}
```

This gives users a concrete command to check when the message is complete.

---

### 2. Race condition in state-dependent commands (P1 - needs investigation)

**File:** `ax.js:3256-3275` (cmdApprove), and similar in cmdReject

**Problem:** Commands check state, then act based on that state. But state can change between check and action.

```bash
ax agents          # Shows session in "confirming" state
ax approve --session=xxx   # ERROR: not confirming (state changed)
```

**Root cause:** The screen is captured, state is checked, then keys are sent. Another process (or the agent itself) can change state in between.

**Status:** Needs investigation before picking a fix. Possible approaches:
1. Retry loop: if state changed, re-check before erroring
2. Atomic operation: capture screen and send keys in one tmux command
3. Accept "not confirming" as success if state is now READY/THINKING (action may have happened)

**TODO:** Investigate actual race scenarios, understand how often this happens, then pick an approach. May be easier to tackle after simpler bugs are fixed.

---

### 3. Silent output when state is READY (P1)

**Files:** `ax.js:3461-3481` (cmdStatus), `ax.js:3420-3450` (cmdOutput)

**Problem:** When state is READY, these commands print nothing and exit 0. Confusing for interactive use.

```bash
ax status --session=xxx   # (No content) - Did it work? What state?
ax output --session=xxx   # (No content) - Is there no output?
```

**Fix:** Always print something:
```javascript
// cmdStatus
if (state === State.READY) {
  console.log("READY");
  process.exit(0);
}

// cmdOutput - if no output found
console.log("(No response yet)");
```

---

## DX Improvements

### 4. Session confusion - unclear which session is targeted (P1)

**Problem:** When you run `ax "message"`, it's unclear which session receives it. Default session selection is implicit.

**Symptoms:**
- Sent message, couldn't find which session got it
- Had to grep through multiple session logs

**Fix:** Add a `TARGET` column to `ax agents` output:

```
SESSION                                   TOOL    STATE   TARGET  TYPE  LOG
claude-partner-39ef854c-...               claude  ready           -     ...
claude-partner-497d7a9d-...               claude  ready   *       -     ...
codex-partner-abc123-...                  codex   ready   *       -     ...
```

The `*` marker shows which session each agent type (claude/codex) will target by default.

**Implementation (`cmdAgents`):**

1. For each agent type, call `agent.getDefaultSession()` to get the default session name
2. When printing rows, add `*` to the TARGET column if session matches that agent's default
3. Note: there may be one default per agent type (one for claude, one for codex)

**How `getDefaultSession()` works (line 1625):**
1. Environment variable (e.g., `AX_SESSION`)
2. CWD matching - finds existing session with same working directory
3. Process parent chain walking + CWD matching

Note: `findParentSession()` is separate and only used by archangels.

---

### 5. Timeout debugging is opaque (P2)

**Problem:** When timeout occurs, no information about what was happening:
- Was the agent stuck thinking?
- Was it waiting for confirmation?
- How much time was left?

**Fix:** On timeout, print last known state:
```
ERROR: timeout after 120s
Last state: THINKING
Session: claude-partner-xxx
Hint: Try ax debug --session=xxx to see current screen
```

---

### 6. Help text doesn't indicate message must come first (P2)

**File:** `ax.js` help output

**Problem:** Help text shows flags before message in examples, but positional argument handling requires message first when combined with certain flags.

**Fix:** Update help text and examples to show correct ordering, or fix argument parsing to be order-independent.

---

### 7. Help text should show actual default values (P1)

**File:** `ax.js` help output / `printHelp()`

**Problem:** The help text doesn't show default values for flags like `--timeout`. This causes users (including LLMs) to guess at values instead of relying on sensible defaults.

**Fix:** Interpolate the actual constants into help text:

```javascript
// Instead of:
"  --timeout=N               Set timeout in seconds"

// Use:
`  --timeout=N               Set timeout in seconds (default: ${DEFAULT_TIMEOUT_MS / 1000}, reviews: ${REVIEW_TIMEOUT_MS / 1000})`
```

This keeps help text in sync with code and makes defaults discoverable.

---

### 8. No streaming output during long-running commands (P1)

**Files:** `ax.js:2016-2052` (waitForResponse), `ax.js:2062-2085` (autoApproveLoop)

**Problem:** Commands block and show nothing until completion.

**Current behavior (bad):**
```
$ ax "review PLAN.md" --wait
[... 2 minutes of silence ...]
[entire response dumped at once]
```

**Current code structure:**
```javascript
// waitForResponse (line 2016) - runs every 200ms
while (Date.now() - start < timeoutMs) {
  await sleep(POLL_MS);
  const screen = tmuxCapture(session);  // Captures screen
  const state = agent.getState(screen);  // Detects state
  // ... checks for terminal states ...
  // BUT PRINTS NOTHING - just waits
}
return { state, screen };  // Only returns at end
```

The response is then extracted from JSONL via `getResponse()` (line 1880) which calls `getAssistantText()`.

**Architecture:**
- **JSONL logs** (e.g., `~/.claude/projects/.../uuid.jsonl`) = source of truth for content
- **Tmux screen** = used only for state detection (THINKING, CONFIRMING, READY)
- JSONL entries are one JSON object per line, with `type` field ("user", "assistant", "tool_use", "tool_result")

**Desired behavior:**
```
$ ax "review PLAN.md" --wait
Sent to: claude-partner-abc123
[THINKING]
> Read(PLAN.md)
[THINKING]

The plan has several strong points...

[CONFIRMING] Bash: npm test
```

**Fix: Modify `waitForResponse` to stream from JSONL while polling**

1. Get log path via `agent.findLogPath(session)`
2. Track file size/offset at start
3. In the polling loop:
   - Read new bytes from JSONL since last offset
   - Parse complete JSON lines
   - Print based on entry type:
     - `assistant` with `text` → print the text content
     - `tool_use` → print `> ToolName(summary of args)`
     - `tool_result` → skip or print truncated summary
   - Update offset
   - Continue existing screen capture for state detection
   - Print state changes: `[THINKING]`, `[CONFIRMING]`, etc.

4. Exit conditions unchanged (READY, CONFIRMING, RATE_LIMITED, timeout)

**Key functions to add:**
- `tailJsonl(logPath, fromOffset)` → returns { entries: [], newOffset }
- `formatEntry(entry)` → returns human-readable string or null

**Example JSONL entry (assistant message):**
```json
{"type":"assistant","message":{"content":[{"type":"text","text":"Here is my analysis..."}]}}
```

**Example JSONL entry (tool use):**
```json
{"type":"assistant","message":{"content":[{"type":"tool_use","name":"Read","input":{"file_path":"/foo/bar.js"}}]}}
```

---

### 9. Clarify `--no-wait` vs backgrounding in help text (P2)

**Problem:** LLMs might see `--no-wait` and think it's for backgrounding tasks. It's not - it's fire-and-forget. This causes confusion.

**Context:** Claude Code has Ctrl+B backgrounding - you can background a running command and it continues, streaming output to a task file, then sends a `<task-notification>` when complete. This is different from `--no-wait`.

**The two patterns:**

1. **Fire-and-forget (`--no-wait`)**: Send message, return immediately, retrieve result later manually
   ```bash
   ax "task" --no-wait
   # Later: ax status --session=ID && ax output --session=ID
   ```

2. **Backgrounding (Ctrl+B in Claude Code)**: Command keeps running, output streams to task file, notification on completion
   - This already works - `ax` is just a CLI
   - But requires #10 (streaming) so output appears incrementally, not buffered until end

**Fixes:**

1. Update help text for `--no-wait`:
   ```
   --no-wait    Fire-and-forget. Prints session ID for later retrieval.
   ```

2. Add note about long-running commands (helps LLMs choose the right pattern):
   ```
   Note: Reviews and complex tasks may take several minutes.
         Consider using Bash run_in_background for long operations.
   ```

   Or in examples:
   ```
   ax review pr --wait            # May take 5-15 minutes; consider backgrounding
   ```

3. Ensure `--no-wait` output (per #1) explains how to check later.

**Why this matters:** With #9 (streaming) fixed, backgrounded commands will incrementally write output to the task file, giving visibility into progress. The default for LLMs should be to background long tasks, not block.

**Dependencies:**
- #1 must be fixed first (so `--no-wait` actually prints session ID)
- #9 should be fixed (so backgrounded commands stream output properly)

---

## Test Cases to Add

```bash
# Feedback on --no-wait
./ax.js "test" --no-wait                  # Should print session ID

# Race condition
# (harder to test - need to simulate state change during command)

# Empty output
ax status --session=xxx                   # Should print "READY" not nothing
```
