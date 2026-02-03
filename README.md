# ax-agents

<p align="center">
  <img src="assets/luca-giordano-the-fall-of-the-rebel-angels.jpg" alt="The Fall of the Rebel Angels by Luca Giordano" width="250">
  <br><br>
  <strong>A CLI for orchestrating AI coding agents via `tmux`.</strong>
</p>

Running agents in `tmux` sessions makes it easy to monitor multiple agents, review their work, and interact with them when needed.

## Install

```
npm install -g ax-agents
```

## Usage

```
ax "what do you think of the error handling here?"
axclaude review uncommitted
axcodex --session=frontend "check the auth flow"
ax do "fix the login bug" --loop
```

Aliases `axclaude` and `axcodex` select the tool directly, or use `ax --tool=NAME`.

Run `ax --help` for all options.

## Archangels

Archangels are background agents that watch your codebase and surface observations to your main coding session.

Configure them in `.ai/agents/*.md`, then:

```
ax summon              # summon all archangels
ax summon reviewer     # summon one by name
ax recall              # recall all
ax recall reviewer     # recall one
```

When you next prompt Claude, any observations from your archangels will be injected automatically.

## License

MIT
