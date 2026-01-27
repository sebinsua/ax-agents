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

## Foundational: Enabling Changes for ax

These architectural improvements enable the features described later.

### 1. Unified Session Metadata Function

ax currently reads JSONL for narrow purposes (streaming, last assistant text). Add a unified abstraction:

```javascript
function getSessionMeta(sessionName) {
  // Parse UUID from session name
  // Find and read last JSONL entry
  // Return unified metadata
  return { slug, todos, permissionMode, gitBranch, cwd };
}
```

**Enables:** orientation derivation, richer `ax agents` output

### 2. Extract Project Path Helper

The `/Users/foo` → `-Users-foo` mapping is done inline. Extract as reusable:

```javascript
function cwdToProjectPath(cwd) {
  return cwd.replace(/\//g, "-");
}
```

### 3. Enrich `ax agents` Output

Show session metadata at a glance:

```
SESSION                  TOOL    STATE   PLAN                      BRANCH
claude-partner-abc123    claude  ready   curious-roaming-pascal    feature/x
claude-archangel-def456  claude  thinking  -                       main
```

New columns: PLAN (slug or "-"), BRANCH (from JSONL)

### 4. What ax Currently Uses vs Available

| Field | In JSONL | Used by ax |
|-------|----------|------------|
| `slug` | ✓ | ✗ |
| `todos` | ✓ | ✗ |
| `permissionMode` | ✓ | ✗ |
| `gitBranch` | ✓ | ✗ |
| `cwd` | ✓ | ✗ |
| `message.content` | ✓ | ✓ (streaming, last text) |
| `type` | ✓ | ✓ (filtering) |

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

### How It Works

**The watcher (not the archangel) is responsible for:**
1. Reading orientation.json
2. Deriving plan/todos from session JSONL
3. Preparing appropriate context for the archangel prompt

Archangels don't read orientation.json directly - they receive context injected by the watcher.

### Auto-population: Read Session JSONL

Claude Code already tracks everything we need in session JSONL files. Zero-friction auto-population:

1. **Session UUID from tmux name**: `claude-partner-2adb3128-ed48-46bf-bd1d-309728268cb3` → UUID is `2adb3128-...`

2. **Session JSONL path**: `~/.claude/projects/{project-path}/{uuid}.jsonl`
   - Project path: `/Users/foo/dev/bar` → `-Users-foo-dev-bar`

3. **Plan slug from JSONL**: Each message entry includes `"slug": "curious-roaming-pascal"` when a plan is active

4. **Derived paths**:
   - Plan: `~/.claude/plans/{slug}.md`
   - Todos: `~/.claude/todos/{uuid}-agent-{uuid}.json`

**No hooks needed.** The watcher just reads the parent session's JSONL to get the current plan slug.

### Open Questions

**Do we need orientation.json at all?** If the watcher can derive everything from session JSONL on-demand, maybe we skip the intermediate file and derive directly:
- Pro: No state to manage, no staleness, no TTL questions
- Con: JSONL parsing on every archangel trigger (but it's fast - just read last few lines)

**Reset semantics** (if we keep orientation.json):
- When session ends? But sessions can be resumed...
- When a new plan is created? Old reference becomes stale
- 24hr TTL like mailbox-last-seen?
- Branch-scoped expiry?

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

1. **Foundational: `getSessionMeta()` + helpers** - Unified session metadata extraction
2. **Foundational: Enrich `ax agents`** - Show plan/branch columns
3. **Incremental context updates** - Stop re-sending full context to stateful archangels
4. **Archangel orientation** - Watcher derives plan/todos from session JSONL, injects into prompts
5. **Task suggestions** - Let archangels propose work items (lowest priority)

---

## Open Research Questions

- Should we derive orientation on-demand from session JSONL, or cache in orientation.json?
- If caching: what are the right reset/expiry semantics?
- How do we handle multiple concurrent plans (different branches, different goals)?
- Should the watcher detect when plan/todos change mid-session and send incremental updates?
