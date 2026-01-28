# TODO

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
