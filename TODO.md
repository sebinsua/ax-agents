# TODO

## Session CWD Matching: Walk Parent Directories

Currently `getDefaultSession()` only matches sessions with exact cwd match. This is too rigid.

**Problem:** If you're in `/project/src/` and the session was started in `/project/`, ax returns NO_TARGET even though you're clearly working in the same project.

**Proposed fix:** Walk up the directory tree to find matching sessions:

1. Check exact cwd match (current behavior)
2. Walk up parent directories (stopping at git root or home)
3. Return the first session found in a parent directory

```javascript
// In getDefaultSession()
let searchDir = cwd;
while (searchDir !== os.homedir() && searchDir !== '/') {
  const existing = sessions.find((s) => {
    if (!childPattern.test(s)) return false;
    const sessionCwd = getTmuxSessionCwd(s);
    return sessionCwd === searchDir;
  });
  if (existing) return existing;

  // Stop at git root
  if (existsSync(path.join(searchDir, '.git'))) break;

  searchDir = path.dirname(searchDir);
}
```

**Considerations:**
- Should prefer exact match over parent match
- Stop at git root (don't leak across projects)
- Stop at home directory
- May want to limit depth (e.g., max 5 levels up)

## Reframe --no-wait Output: Remove Polling Nudge, Add Task Tracking Nudge

**Problem:** When an LLM uses `ax send --no-wait`, the current output teaches it to poll:

```
Sent to: e1c8b784

e.g.
  ax status --session=e1c8b784
  ax output --session=e1c8b784
```

The "e.g." with status/output commands acts like handing someone a fidget toy - triggers a loop of: send → check status → still thinking → check again → repeat.

But simply removing the polling commands risks the LLM forgetting it ever sent the task.

**Fix:** Replace polling nudge with task tracking nudge:

```
Sent to: e1c8b784
Task: review auth code for security issues

Track this task, then continue with your work.
```

- Show the task description (memorable, unlike session ID alone)
- "Track this task" nudges LLM to use its own TaskCreate
- "continue with your work" sets async expectation
- Don't show polling commands (ax status/output) - bury those in Recovery section of `--help`
- Polling becomes a recovery/debugging action, not the happy path

The LLM's task list becomes the reminder mechanism, not ax output.

## ax output Shows Stale Data While Thinking

**Problem:** When ax is processing a new request, `ax output` returns the previous response with no indication it's stale. This is misleading:

1. LLM calls `ax output`
2. Gets a response (looks successful)
3. Acts on it
4. Later discovers it was from a previous request

**Fix:** Either refuse or warn when ax is mid-thought:

Option A - Refuse:
```
ax output
> ax is currently processing. Use --wait or check back later.
```

Option B - Warn:
```
ax output
> ⚠ ax is processing a new request. Showing previous response:
> [old output]
```

Option A is cleaner - don't give data that will mislead. Stale data presented as current is worse than no data.

## Handle Claude CLI Feedback Modal

**Bug:** When Claude CLI shows its feedback modal, `ax send` reports success but keys are swallowed.

The modal appears after Claude finishes responding:
```
● How is Claude doing this session? (optional)
  1: Bad    2: Fine   3: Good   0: Dismiss
```

**Problem:**
- ax detects state as "thinking" (matches text in output)
- `ax send` types the message but it goes into the modal, not the input
- User's message is lost

**Fix:** Detect this modal in state detection and auto-dismiss with Escape before sending messages. Could also detect by looking for the `●` bullet and "How is Claude doing" text pattern.

## Per-Command Auto-Approve Glob

Allow auto-approving specific tool commands that match a pattern, specified per-ax-invocation:

```bash
ax send --auto-approve='Bash("cargo *")' "test all the game paths"
```

Similar to Claude's existing settings.json permission patterns, but specified dynamically for a single ax interaction. Syntax TBD - could mirror whatever format Claude uses in its settings.

Useful for testing workflows where the agent needs to run many similar commands without constant approval interruptions.

## Async/Parallel Usage Patterns (Discussion)

**Problem:** When an LLM uses ax, it defaults to synchronous patterns - send message, wait for response, continue. This wastes the potential for parallelism.

**Observation:** The current `--no-wait` flag exists but doesn't change the fundamental interaction pattern. The caller still thinks sequentially.

### Possible approaches

**1. Task Queue**
```bash
ax queue "write tests for auth module"
ax queue "review error handling in api/"
ax queue "check for security issues"
ax work  # process queue, maybe in parallel
```
- Pro: Explicit batching encourages thinking about what can parallelize
- Con: Adds complexity, may not change LLM behavior

**2. Archangels with Write Permissions**
Currently archangels seem oriented toward read-only tasks (review, analysis). What if archangels could:
- Implement features in parallel
- Run in background, write to branches
- Coordinate via mailbox

Questions:
- How to handle conflicts when multiple agents write?
- Git branches per archangel?
- How does the "parent" agent merge/review?

**3. Work-Stealing / Parallel Execution**
```bash
ax parallel "task1" "task2" "task3"  # runs all concurrently
ax gather  # collects results
```

**4. Structured Handoffs**
Instead of free-form messages, structured task definitions:
```bash
ax task --type=implement --files="src/foo.rs" --spec="add caching"
ax task --type=test --target="src/foo.rs"
```
More machine-readable, easier to parallelize.

### Open Questions
- Does forcing async actually help, or will LLMs revert to sync patterns?
- Is the mailbox already sufficient for coordination?
- Should there be a "foreman" pattern - one agent dispatches, others execute?
