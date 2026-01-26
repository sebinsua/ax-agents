# ax-agents

A CLI for orchestrating AI coding agents via `tmux`.

## Install

```
npm install -g ax-agents
```

## Usage

```
ax "what do you think of the error handling here?"
ax review uncommitted
ax --session=frontend "check the auth flow"
ax --yolo "fix the login bug"
```

Run `ax --help` for all options.

## Why

Running AI agents in tmux sessions makes it easy to monitor multiple agents, review their work, and interact with them when needed. This tool handles the session management so you can focus on the prompts.

## License

MIT
