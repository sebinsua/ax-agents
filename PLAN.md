# ax-agents: Multi-Agent Orchestration Plan

## Context

This document captures ideas for improving ax-agents as a multi-agent orchestration tool. The core insight driving this exploration: **human ideation doesn't scale fast enough to direct many agents**. Adding coordination infrastructure assumes you have more good ideas than you can execute - but the bottleneck is often "what should agents do?" not "how do agents communicate?"

## What's Already Working

### Background Reviewing (Archangels)
The archangel pattern is valuable because it **removes ideation burden** - agents watch for changes and decide what's worth commenting on. The human doesn't have to ask "review this file", the agent notices and speaks up. More quality checking is good.

### Bidirectional Communication
Already exists via `ax ask --session <id> "message"`. No new infrastructure needed.

### Claude Code's Existing Infrastructure
Claude Code already persists:
- **Plans**: `~/.claude/plans/<slug>.md` - markdown files with whimsical names
- **Todos**: `~/.claude/todos/<session-uuid>-agent-<agent-id>.json` - JSON arrays:
  ```json
  [
    {"content": "Task description", "status": "completed", "activeForm": "Doing task"}
  ]
  ```
- **Teams/Tasks**: `~/.claude/tasks/<team-name>/` - for multi-agent coordination

We should leverage these, not build parallel systems.

### Codex Hooks
Codex has hooks via `notify` config in `~/.codex/config.toml`:
```toml
notify = ["python3", "/path/to/notify.py"]
```
Events include `agent-turn-complete` with `thread-id`, `input-messages`, `last-assistant-message`.

---

## Problem 1: Archangels Can't Orient Around the Plan

Archangels review code in a vacuum - they see *what* changed but not *why* or *what the goal is*. If they knew the plan and todos, their observations would be much more relevant:
- "This change doesn't seem to advance any plan item"
- "This might complete step 3 of the plan"
- "Consider adding a todo for error handling here"

### Proposed Solution: orientation.json

A dynamic file that points to current context, keyed by session (like `mailbox-last-seen.json`):

```json
{
  "claude-abc123": {
    "plan": "~/.claude/plans/wondrous-splashing-planet.md",
    "todos": "~/.claude/todos/abc123-agent-abc123.json",
    "goal": "Implementing filter chain fusion",
    "branch": "feature/filter-fusion",
    "updatedAt": "2026-01-27T10:00:00Z"
  }
}
```

Location: `.ai/orientation.json`

Archangels already have `AX_ARCHANGEL_PARENT_UUID` - they use that to look up their parent's orientation.

### Open Questions

**Auto-population**: Manual configuration is too high friction. Must be zero-cost.
- Hook could watch for Write/Edit calls to `~/.claude/plans/*.md` → auto-update orientation
- Todo path is deterministic from session ID → always inferrable

**Reset semantics**: When does orientation get cleared?
- When session ends? But sessions can be resumed...
- When a new plan is created? Old reference becomes stale
- 24hr TTL like mailbox-last-seen?
- Branch-scoped expiry?

**Alternative - derive instead of store**: Archangels could infer context on-demand:
- Plan = most recently modified `~/.claude/plans/*.md`
- Todos = `~/.claude/todos/<parent-session>-*.json`
- Problem: most recently modified plan isn't necessarily the *active* plan

---

## Problem 2: Archangels Are Stateful But Treated as Stateless

Archangels run in **persistent tmux sessions**. They have conversation history - they remember previous messages. But the watcher re-sends full context every cycle:
- Full parent context
- Full plan
- Full todos
- All changed files

This is wasteful when context hasn't changed.

### Proposed Solution: Incremental Context Updates

Track what each archangel has seen:

```json
// .ai/archangel-state/reviewer.json
{
  "initialized": true,
  "planHash": "abc123",
  "todosHash": "def456",
  "parentContextOffset": 42,
  "lastAnalysisAt": "2026-01-27T10:00:00Z"
}
```

Watcher behavior:

**First trigger (uninitialized)**:
> "Here's the plan, here's the todos, here's the parent context. Files A, B changed - please review."

**Subsequent triggers (no context change)**:
> "Files C, D changed - please review."
> (Archangel already knows plan/todos/context from conversation history)

**When context changes**:
> "Update: the plan has changed. Here's the new plan: [content]"
> "Update: new todo added: 'Add error handling for auth flow'"

The archangel's conversation memory IS the state. We just need to leverage it.

### Implementation Notes

- Hash plan/todos content to detect changes
- Track parent context offset (like mailbox-last-seen tracks message offset)
- First message to archangel includes full context
- Subsequent messages include only diffs
- On orientation change, send explicit update message

---

## Problem 3: Task Suggestions from Archangels

Archangels might notice work that should be done:
- "This function needs error handling"
- "Tests are missing for this new code path"
- "This TODO comment should become a real task"

### Proposed Solution: Task Suggestion Message Type

Archangels write to mailbox with `type: "task-suggestion"`:

```json
{
  "timestamp": "2026-01-27T10:00:00Z",
  "type": "task-suggestion",
  "payload": {
    "agent": "reviewer",
    "session": "claude-abc123",
    "suggestion": "Add error handling for the new auth flow",
    "context": "Noticed in src/auth/login.ts - the new OAuth code doesn't handle token refresh failures",
    "priority": "medium"
  }
}
```

The hook renders these differently from observations. The main agent or human decides whether to add them to the todo list.

---

## Non-Goals / Rejected Ideas

### Task Queues
"Humans don't work through queues. You have 1-3 tasks in flight, priorities shift dynamically. A task queue is a computer science abstraction, not how humans work."

### Inter-Archangel Coordination Infrastructure
"The prompting itself aligns them. This is like having different people on your team with different priorities." Different archangels focus on different concerns via their system prompts - they don't need technical coordination layers.

### Building Parallel Infrastructure
Claude Code already has plans, todos, tasks. Use those, don't rebuild.

---

## Implementation Priority

1. **Incremental context updates** - Stop re-sending full context to stateful archangels
2. **orientation.json** - Let archangels know about plan/todos (pending resolution of auto-population and reset semantics)
3. **Task suggestions** - Let archangels propose work items

---

## Open Research Questions

- How should orientation.json be auto-populated with zero friction?
- What are the right reset/expiry semantics for orientation?
- Should orientation be derived on-demand rather than stored?
- How do we handle multiple concurrent plans (different branches, different goals)?
