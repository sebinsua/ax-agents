# TODO

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
- Could this be a good time to implement Pi Agents, too: https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent#programmatic-usage

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
