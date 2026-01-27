# ax-agents: Bug Fixes and DX Improvements

## Critical Bugs

### 1. Race condition in state-dependent commands (P1 - needs investigation)

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

## DX Improvements

### 2. Timeout debugging is opaque (P2)

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

### 3. Clarify `--no-wait` vs backgrounding in help text (P2)

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
   - But requires #3 (streaming) so output appears incrementally, not buffered until end

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

**Why this matters:** Since streaming is now implemented, backgrounded commands will incrementally write output to the task file, giving visibility into progress. The default for LLMs should be to background long tasks, not block.

---

### 4. Add `--orphans` flag to `ax kill` (P2)

**Problem:** When tmux sessions die or terminals are closed abruptly, Claude processes can become orphaned (reparented to PID 1) and keep running in the background. The current `kill` command only kills tmux sessions—it doesn't clean up these orphaned processes.

**Symptoms:**
- `top` shows many node processes running `claude`
- These processes have PPID=1 (orphaned)
- `ax kill --all` doesn't remove them

**Fix:** Add `--orphans` flag to find and kill orphaned claude processes:

```bash
ax kill --orphans           # Kill orphaned claude processes in addition to tmux sessions
ax kill --all --orphans     # Kill all sessions + orphans
```

**Implementation:**
1. Add `orphans` boolean flag to parseArgs
2. In `cmdKill`, if `--orphans`:
   - Find processes where: command contains "claude", PPID=1
   - Kill them with SIGKILL
   - Report count killed

```javascript
function killOrphanedProcesses() {
  // Find orphaned claude processes (PPID=1)
  const result = spawnSync("sh", ["-c",
    "ps -eo pid,ppid,args | awk '$2 == 1 && /node.*claude/ {print $1}'"
  ], { encoding: "utf-8" });

  const pids = result.stdout.trim().split("\n").filter(Boolean);
  for (const pid of pids) {
    spawnSync("kill", ["-9", pid]);
  }
  return pids.length;
}
```

3. Update help text:
```
kill                      Kill sessions (--all, --session=NAME, --orphans)
```

---

## Test Cases to Add

```bash
# Race condition
# (harder to test - need to simulate state change during command)
```
