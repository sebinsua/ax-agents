# ax-agents: Multi-Agent Orchestration Plan

## Context

This document captures ideas for improving ax-agents as a multi-agent orchestration tool. The core insight driving this exploration: **human ideation doesn't scale fast enough to direct many agents**. Adding coordination infrastructure assumes you have more good ideas than you can execute - but the bottleneck is often "what should agents do?" not "how do agents communicate?"

---

## Foundational: Claude Code Data Model

Understanding Claude Code's internal data structures enables richer integration.

> **Note: Claude-only features.** The session metadata described here (slug, todos, permissionMode, gitBranch) is specific to Claude Code. Codex uses a different session format without these fields. Features that depend on this data must:
> 1. Detect which agent type the session belongs to
> 2. Gracefully degrade for Codex (return null/"-", skip orientation injection)
> 3. Only enable rich features for Claude sessions
>
> `getSessionMeta()` should return `null` for Codex sessions rather than failing.

### Session JSONL

Each session is stored at `~/.claude/projects/{project-path}/{session-uuid}.jsonl`

**Project path derivation**: `/Users/foo/dev/bar` → `-Users-foo-dev-bar` (replace `/` with `-`)

**Key fields per entry:**

| Field | Description |
|-------|-------------|
| `sessionId` | Session UUID |
| `slug` | Plan identifier (when plan is active) |
| `todos` | Current todo array |
| `permissionMode` | "default", "acceptEdits", "plan" |
| `gitBranch` | Current git branch |
| `cwd` | Working directory |
| `type` | "user" or "assistant" |
| `message` | Message content |
| `uuid` | Message UUID |
| `parentUuid` | For message threading |
| `timestamp` | ISO timestamp |

### Related Paths

| Data | Path |
|------|------|
| Session JSONL | `~/.claude/projects/{project-path}/{uuid}.jsonl` |
| Plans | `~/.claude/plans/{slug}.md` |
| Todos | `~/.claude/todos/{uuid}-agent-{uuid}.json` |
| Teams/Tasks | `~/.claude/tasks/{team-name}/` |

### Session Name → UUID Mapping

Tmux session names contain the UUID: `claude-partner-2adb3128-ed48-46bf-bd1d-309728268cb3` → UUID is `2adb3128-ed48-46bf-bd1d-309728268cb3`

---

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

## Problem: Task Suggestions from Archangels

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

## Open Research Questions

- How do we handle multiple concurrent plans (different branches, different goals)?
