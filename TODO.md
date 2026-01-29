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

## Terminal Abstraction Layer

Inspired by tuistory (Playwright-like TUI testing framework). Extract a clean interface boundary between terminal interaction and agent logic.

### Core Interface

```ts
interface TerminalStream {
  readNext(opts?: { max?: number; timeoutMs?: number }): Promise<TerminalLine[]>
  waitForMatch(query: MatchQuery, opts?: { timeoutMs?: number }): Promise<MatchResult>
}
```

Style filters in `MatchQuery` are silently ignored when the underlying implementation doesn't support them (JSONL). No capability check needed - if it doesn't exist, don't expose it.

### Implementations

1. **JsonlTerminalStream** (primary) - reads Claude's JSONL logs directly, structured data
2. **StyledTuiTerminalStream** (fallback) - screen scraping with style awareness for Codex

### What stays in Agent

The `lastLines`/`recentLines` slicing logic stays in `detectState()`. The stream provides structured `TerminalLine[]`, but the agent still decides:
- Last 8 lines for prompt detection
- Last 15 lines for confirmation dialogs
- Full screen for update banners

This domain knowledge belongs in the agent, not the stream abstraction.

### Benefits
- Agent logic becomes testable with a fake terminal
- Clean separation of "how to read terminal" from "what agent states mean"
- Easier to add new agent types

### Tasks
- [ ] Define `TerminalLine`, `TextSpan`, `Style`, `MatchQuery`, `MatchResult` types
- [ ] Extract `TerminalStream` interface from existing code
- [ ] Implement `JsonlTerminalStream` wrapping current JSONL reading
- [ ] Implement `StyledTuiTerminalStream` using `tmux capture-pane -e` for ANSI styles
- [ ] Refactor `Agent` class to consume `TerminalStream` instead of direct tmux/log access

## Styling-Aware Pattern Matching

For the TUI fallback path (Codex), detect ANSI colors and text attributes to improve state detection reliability.

### Use Cases
- Distinguish prompts from output (prompts often colored/bold)
- Detect error states (red text)
- Identify thinking/processing indicators
- Reduce false positives in pattern matching

### Implementation Notes
- Parse ANSI escape sequences from `tmux capture-pane -e` output
- Map to normalized `Style` type (fg, bg, bold, dim, italic, underline)
- Extend `MatchQuery` to optionally filter by style
- JSONL stream silently ignores style filters (no capability check - just doesn't match on style)

### Tasks
- [ ] Add ANSI escape sequence parser
- [ ] Extend tmux capture to use `-e` flag for escape sequences
- [ ] Implement style-aware `findMatch()` function
- [ ] Update Codex-specific state detection to use style hints where helpful

## CLI Aliases

Add common aliases for discoverability:

- [ ] `list` → `agents` (common convention: `docker ps`, `git branch --list`)
