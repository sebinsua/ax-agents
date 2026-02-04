# TODO: Refactor Agent Architecture + Add Pi Support

## Goal

1. **Fix the architecture**: The Agent class is currently just a config holder, with tmux logic scattered across 65+ standalone function calls. This makes adding new backends painful.

2. **Add Pi support**: Once architecture is fixed, adding Pi ([@mariozechner/pi-coding-agent](https://github.com/badlogic/pi-mono/tree/main/packages/coding-agent)) becomes straightforward.

## The Problem

**Current design** - Agent is config, session is a string, functions do the work:
```javascript
// Agent is just config
const ClaudeAgent = new Agent({
  promptSymbol: "❯",
  spinners: [...],
})

// Session is just a string (tmux session name)
const session = await cmdStart(agent, null, { yolo })

// Functions take agent + session string, call tmux directly
await tmuxSendText(session, prompt)
const screen = tmuxCapture(session)
const state = agent.getState(screen) // Agent only interprets, doesn't act
```

**Pi's design** - Session is an object with methods:
```javascript
const { session } = await createAgentSession(options)
await session.prompt("fix the bug")
session.subscribe(event => { /* streaming */ })
session.isStreaming // state as property
session.newSession() // lifecycle methods
```

## Target Design

Learn from Pi's interface design. Session should be an object with methods:

```javascript
// Agent creates sessions
const session = await agent.createSession({ cwd, yolo })

// Session has methods (like Pi)
await session.prompt("fix the bug")
for await (const chunk of session.stream()) {
  console.log(chunk.content)
}
await session.approve()
await session.newConversation()
session.state // THINKING, READY, CONFIRMING, etc.

// Implementation is internal - not exposed
// TmuxSession uses tmux, PiSession uses Pi SDK
```

---

## Architecture

### Core Classes

```javascript
/**
 * Base Agent class - creates sessions
 */
class Agent {
  constructor(config) {
    this.name = config.name
    this.displayName = config.displayName
    // ... other config
  }

  /**
   * Create a new session
   * @returns {Promise<AgentSession>}
   */
  async createSession(options) {
    throw new Error('Subclass must implement')
  }

  /**
   * Find existing session or create new one
   * @returns {Promise<AgentSession>}
   */
  async getOrCreateSession(options) {
    throw new Error('Subclass must implement')
  }
}

/**
 * Session interface - what commands interact with
 */
class AgentSession {
  /** @type {string} */
  get id() { throw new Error('Subclass must implement') }

  /** @type {string} */
  get cwd() { throw new Error('Subclass must implement') }

  /** @type {string} - STARTING, THINKING, READY, CONFIRMING, RATE_LIMITED */
  get state() { throw new Error('Subclass must implement') }

  /** @type {boolean} */
  get isStreaming() { throw new Error('Subclass must implement') }

  /** Send a prompt and wait for completion */
  async prompt(text) { throw new Error('Subclass must implement') }

  /** Stream output chunks as they arrive */
  async *stream() { throw new Error('Subclass must implement') }

  /** Approve pending confirmation */
  async approve() { throw new Error('Subclass must implement') }

  /** Reject pending confirmation */
  async reject() { throw new Error('Subclass must implement') }

  /** Start fresh conversation (/new) */
  async newConversation() { throw new Error('Subclass must implement') }

  /** Get last response text */
  async getResponse() { throw new Error('Subclass must implement') }

  /** Destroy session */
  async destroy() { throw new Error('Subclass must implement') }
}
```

### Tmux Implementation (Claude, Codex)

```javascript
class TmuxAgent extends Agent {
  constructor(config) {
    super(config)
    this.startCommand = config.startCommand
    this.yoloCommand = config.yoloCommand
    this.promptSymbol = config.promptSymbol
    this.spinners = config.spinners
    this.confirmPatterns = config.confirmPatterns
    // ... tmux-specific config
  }

  async createSession({ cwd, yolo }) {
    const sessionName = this.generateSessionName({ yolo })
    const command = yolo ? this.yoloCommand : this.startCommand
    tmuxNewSession(sessionName, command)
    await this._waitForReady(sessionName)
    return new TmuxSession(this, sessionName, cwd)
  }

  async getOrCreateSession({ cwd, yolo, sessionName }) {
    if (sessionName && tmuxHasSession(sessionName)) {
      return new TmuxSession(this, sessionName, cwd)
    }
    // ... existing default session finding logic
    return this.createSession({ cwd, yolo })
  }
}

class TmuxSession extends AgentSession {
  constructor(agent, sessionName, cwd) {
    super()
    this._agent = agent
    this._sessionName = sessionName
    this._cwd = cwd
  }

  get id() { return this._sessionName }
  get cwd() { return this._cwd }

  get state() {
    const screen = tmuxCapture(this._sessionName)
    return detectState(screen, this._agent)
  }

  get isStreaming() {
    return this.state === State.THINKING
  }

  async prompt(text) {
    await tmuxSendText(this._sessionName, text)
  }

  async *stream() {
    const terminalStream = this._agent.createStream(this._sessionName, { skipExisting: true })
    // Polling loop - yield chunks as they arrive
    while (true) {
      const lines = await terminalStream.readNext()
      for (const line of lines) {
        yield { type: line.lineType || 'text', content: line.raw }
      }
      const state = this.state
      if (state === State.READY || state === State.CONFIRMING || state === State.RATE_LIMITED) {
        break
      }
      await sleep(POLL_MS)
    }
  }

  async approve() {
    tmuxSend(this._sessionName, this._agent.approveKey)
  }

  async reject() {
    tmuxSend(this._sessionName, this._agent.rejectKey)
  }

  async newConversation() {
    tmuxSendLiteral(this._sessionName, "/new")
    tmuxSend(this._sessionName, "Enter")
    await this._waitForReady()
  }

  async getResponse() {
    const screen = tmuxCapture(this._sessionName)
    return this._agent.getResponse(this._sessionName, screen)
  }

  async destroy() {
    tmuxKill(this._sessionName)
  }
}
```

### Pi SDK Implementation

```javascript
class PiAgent extends Agent {
  constructor() {
    super({
      name: "pi",
      displayName: "Pi",
    })
    this._sdk = null
  }

  async _getSDK() {
    if (!this._sdk) {
      try {
        this._sdk = await import('@mariozechner/pi-coding-agent')
      } catch {
        throw new Error('Pi not installed. Run: npm install @mariozechner/pi-coding-agent')
      }
    }
    return this._sdk
  }

  async createSession({ cwd, yolo }) {
    const sdk = await this._getSDK()
    const { session } = await sdk.createAgentSession({
      cwd,
      sessionManager: sdk.SessionManager.inMemory(),
      // yolo mode: don't register approval extensions
    })
    return new PiSession(session, cwd)
  }
}

class PiSession extends AgentSession {
  constructor(piSession, cwd) {
    super()
    this._pi = piSession
    this._cwd = cwd
    this._id = crypto.randomUUID()
  }

  get id() { return this._id }
  get cwd() { return this._cwd }
  get state() {
    if (this._pi.isStreaming) return State.THINKING
    // TODO: detect CONFIRMING via extension system
    return State.READY
  }
  get isStreaming() { return this._pi.isStreaming }

  async prompt(text) {
    await this._pi.prompt(text)
  }

  async *stream() {
    // Convert Pi's event subscription to async generator
    const chunks = []
    let resolver = null
    let done = false

    const unsubscribe = this._pi.subscribe((event) => {
      if (event.type === 'message_update' && event.assistantMessageEvent?.type === 'text_delta') {
        chunks.push({ type: 'text', content: event.assistantMessageEvent.delta })
      } else if (event.type === 'tool_execution_start') {
        chunks.push({ type: 'tool', content: `> ${event.toolName}(...)` })
      } else if (event.type === 'agent_end') {
        done = true
      }
      resolver?.()
    })

    try {
      while (!done || chunks.length > 0) {
        if (chunks.length > 0) {
          yield chunks.shift()
        } else if (!done) {
          await new Promise(r => { resolver = r })
        }
      }
    } finally {
      unsubscribe()
    }
  }

  async approve() {
    // Pi handles approvals via extensions - may need custom extension
    throw new Error('Pi approval not yet implemented')
  }

  async newConversation() {
    await this._pi.newSession()
  }

  async getResponse() {
    const messages = this._pi.messages
    const last = messages[messages.length - 1]
    return last?.content || null
  }

  async destroy() {
    // Pi sessions are in-memory, nothing to clean up
  }
}
```

### Refactored Commands

```javascript
// Before: 65+ tmux calls scattered everywhere
async function cmdDo(agent, prompt, options) {
  const session = await cmdStart(agent, null, { yolo })
  await tmuxSendText(session, fullPrompt)
  const { state, screen } = await streamResponse(agent, session, timeoutMs)
  const response = agent.getResponse(session, screen)
  // ...
}

// After: clean session-based API
async function cmdDo(agent, prompt, options) {
  const session = await agent.createSession({ cwd: process.cwd(), yolo: options.yolo })

  for (let i = 0; i < iterations; i++) {
    if (i > 0) await session.newConversation()

    await session.prompt(buildDoPrompt(prompt, name))

    for await (const chunk of session.stream()) {
      if (chunk.type === 'thinking') {
        console.log(styleText('dim', chunk.content))
      } else if (chunk.type === 'tool') {
        console.log(styleText('cyan', chunk.content))
      } else {
        console.log(chunk.content)
      }
    }

    if (session.state === State.CONFIRMING && yolo) {
      await session.approve()
      continue
    }

    const response = await session.getResponse()
    if (response?.includes('<promise>COMPLETE</promise>')) {
      console.log(`Completed after ${i + 1} iteration(s)`)
      return
    }
  }
}
```

---

## Implementation Plan

### Guiding Principle: Mechanistic First

Each phase should be **purely mechanical** - no behavior changes, just reorganizing code:

1. **Wrap, don't rewrite**: New classes delegate to existing functions. `session.prompt(text)` just calls `tmuxSendText(sessionName, text)` internally.
2. **Migrate callers one-by-one**: Switch `tmuxSendText(session, text)` → `session.prompt(text)`. Same behavior, different call site.
3. **Tests pass after each phase**: If tests break, you changed behavior - back out and try again.
4. **Defer optimization**: Once everything uses the new API, *then* you can refactor internals.

This is the "strangler fig" pattern: build the new interface alongside the old, migrate gradually, remove the old when nothing uses it.

### Phase 1: Create Wrapper Classes (Non-Breaking)

Create `TmuxSession` as a **thin wrapper** that delegates to existing functions:

```javascript
class TmuxSession {
  constructor(agent, sessionName, cwd) {
    this._agent = agent
    this._sessionName = sessionName
    this._cwd = cwd
  }

  // Each method just calls the existing function
  async prompt(text) {
    tmuxSendText(this._sessionName, text)  // existing function, unchanged
  }

  get state() {
    const screen = tmuxCapture(this._sessionName)  // existing function
    return this._agent.getState(screen)  // existing method
  }

  async approve() {
    tmuxSend(this._sessionName, this._agent.approveKey)  // existing function
  }
  // ... etc
}
```

**Key point**: No changes to `tmuxSendText`, `tmuxCapture`, etc. The wrapper just calls them.

Also add `TmuxAgent.createSession()` that returns a `TmuxSession`:

```javascript
class TmuxAgent extends Agent {
  async createSession({ cwd, yolo }) {
    // Use existing session creation logic
    const sessionName = generateSessionName(this, { yolo })
    const command = yolo ? this.yoloCommand : this.startCommand
    tmuxNewSession(sessionName, command)  // existing function
    await waitForReady(sessionName, this)  // existing function
    return new TmuxSession(this, sessionName, cwd)
  }
}
```

**Files**: ax.js (~100 lines added)
**Tests**: All existing tests still pass (nothing changed behavior)

### Phase 2: Migrate Commands One-by-One

Switch commands from direct tmux calls to session methods. **One command at a time**, verify tests pass after each.

**Order** (simplest first):
1. `cmdApprove` - just calls `session.approve()`
2. `cmdReject` - just calls `session.reject()`
3. `cmdSend` - just calls `session.prompt()`
4. `cmdChat` - uses `session.prompt()` + `session.stream()`
5. `cmdDo` - most complex, do last

Example migration for `cmdApprove`:

```javascript
// Before
async function cmdApprove(agent, sessionName) {
  tmuxSend(sessionName, agent.approveKey)
}

// After
async function cmdApprove(agent, sessionName) {
  const session = new TmuxSession(agent, sessionName, process.cwd())
  await session.approve()
}
```

Same behavior, different call site. Tests still pass.

**Files**: ax.js (~200 lines changed)
**Tests**: Run after each command migration

### Phase 3: Consolidate Session Creation

Once all commands use `TmuxSession`, update `cmdStart` to return a session object instead of a string:

```javascript
// Before
async function cmdStart(agent, sessionName, options) {
  // ... creates tmux session
  return sessionName  // returns string
}

// After
async function cmdStart(agent, sessionName, options) {
  // ... same logic
  return new TmuxSession(agent, sessionName, cwd)  // returns object
}
```

Update all callers of `cmdStart` to expect a session object.

**Files**: ax.js (~100 lines changed)
**Tests**: All pass

### Phase 4: Add PiAgent + PiSession

Now the interface is proven. Adding Pi is straightforward:

1. Create `PiAgent` extending `Agent`
2. Create `PiSession` extending `AgentSession`
3. Lazy-load Pi SDK (optional peer dependency)
4. Implement the same methods using Pi's API
5. Add `axpi` alias

**Files**: ax.js (~150 lines added), package.json
**Tests**: Add Pi-specific tests

### Phase 5: Clean Up

Once everything works:

1. Remove unused helper functions (if any)
2. Consider inlining simple wrappers
3. Update README with Pi support

**Files**: ax.js, README.md

---

## Pi SDK Reference

### Session Creation
```javascript
const { session } = await createAgentSession({
  cwd: "/path/to/project",
  sessionManager: SessionManager.inMemory(), // or .create(), .continueRecent()
  model: myModel,
  thinkingLevel: "high",
  tools: [readTool, bashTool, editTool],
})
```

### Prompting
- `session.prompt(text)` - send and wait for completion
- `session.steer(text)` - interrupt during streaming
- `session.followUp(text)` - queue after completion

### Events
```javascript
session.subscribe((event) => {
  // message_start, message_update, message_end
  // tool_execution_start, tool_execution_update, tool_execution_end
  // agent_start, agent_end, turn_start, turn_end
})
```

### State
- `session.isStreaming` - boolean
- `session.state` - full state object
- `session.messages` - conversation history

### Lifecycle
- `session.newSession()` - equivalent to /new
- `session.fork(entryId)` - branch from message

### Limitations
- No built-in yolo mode - approvals via extension system
- Must use tool factories with cwd: `createBashTool(cwd)` not `bashTool`

---

## Open Questions

1. **Pi approvals**: Pi uses extensions for tool approval. For non-yolo mode, we need a custom extension that integrates with ax's flow. How?

2. **Session persistence**: Pi supports session trees and forking. Expose this or keep simple?

---

## Verification

1. **Existing tests pass**: `node --test ax.test.js`
2. **Claude/Codex still work**:
   ```bash
   axclaude "what files are here?"
   axcodex do "create hello.txt" --loop
   ```
3. **Pi works** (after implementation):
   ```bash
   npm install @mariozechner/pi-coding-agent
   axpi "what files are here?"
   axpi do "create hello.txt" --loop
   ```

---

The key insight: this isn't just "add Pi support" - it's "fix the architecture so adding any new agent is easy." The tmux coupling was technical debt.
