# Archangels: Design Principles

## Core Insight

Human ideation doesn't scale fast enough to direct many agents. The bottleneck is often "what should agents do?" not "how do agents communicate?" Archangels address this by **removing ideation burden** - they watch for changes and decide what's worth commenting on.

## How Archangels Work

Archangels are background reviewers that run in persistent tmux sessions. They:

1. Watch for file changes in the working directory
2. Receive context about what the main session is working on (plan, todos)
3. Review changes and report observations to a mailbox
4. Have conversation memory - they remember previous context

### First Trigger

On first trigger, archangels receive:
- Their identity and focus area
- Generic guidelines for good reviewing behavior
- The current plan and todos (if available)
- File change context

### Subsequent Triggers

Archangels only receive:
- Plan/todos if they've changed (tracked via content hashing)
- File change context

This avoids resending redundant context since archangels have conversation memory.

## Guidelines (injected on first trigger)

```
- Investigate before speaking. If uncertain, read more code and trace the logic until you're confident.
- Explain WHY something is an issue, not just that it is.
- Focus on your area of expertise.
- Calibrate to the task or plan. Don't suggest refactors during a bug fix.
- Be clear. Brief is fine, but never sacrifice clarity.
- For critical issues, request for them to be added to the todo list.
- Don't repeat observations you've already made unless you have more to say or better clarity.
- Make judgment calls - don't ask questions.
```

## Leveraging Claude Code Infrastructure

Archangels derive context from Claude Code's existing data:

| Data | Path |
|------|------|
| Session JSONL | `~/.claude/projects/{project-path}/{uuid}.jsonl` |
| Plans | `~/.claude/plans/{slug}.md` |
| Todos | Embedded in session JSONL |

No parallel infrastructure needed.

## Non-Goals

- **Structured task suggestions** - Archangels write observations. If critical, they request a todo. No special message types.
- **Task queues** - Humans don't work through queues. Priorities shift dynamically.
- **Inter-archangel coordination** - Prompting aligns them. Different archangels focus on different concerns via their config.
