import { describe, it } from "node:test";
import assert from "node:assert";
import {
  parseSessionName,
  parseAgentConfig,
  parseKeySequence,
  getClaudeProjectPath,
  matchesPattern,
  getBaseDir,
  truncate,
  truncateDiff,
  extractTextContent,
  extractToolCalls,
  extractThinking,
  detectState,
  State,
  parseCliArgs,
  normalizeAllowedTools,
  computePermissionHash,
  formatClaudeLogEntry,
  formatCodexLogEntry,
  parseJsonlEntry,
  parseScreenLines,
  parseAnsiLine,
  parseStyledScreenLines,
  findMatch,
  JsonlTerminalStream,
  ScreenTerminalStream,
  StyledScreenTerminalStream,
  FakeTerminalStream,
  CodexAgent,
  ClaudeAgent,
} from "./ax.js";

// =============================================================================
// parseCliArgs - CLI argument parsing
// =============================================================================

describe("parseCliArgs", () => {
  describe("boolean flags", () => {
    it("parses --wait", () => {
      const result = parseCliArgs(["--wait", "message"]);
      assert.strictEqual(result.flags.wait, true);
    });

    it("parses --no-wait", () => {
      const result = parseCliArgs(["--no-wait", "message"]);
      assert.strictEqual(result.flags.noWait, true);
    });

    it("parses --yolo", () => {
      const result = parseCliArgs(["--yolo", "message"]);
      assert.strictEqual(result.flags.yolo, true);
    });

    it("parses --fresh", () => {
      const result = parseCliArgs(["--fresh", "message"]);
      assert.strictEqual(result.flags.fresh, true);
    });

    it("parses --reasoning", () => {
      const result = parseCliArgs(["--reasoning", "agents"]);
      assert.strictEqual(result.flags.reasoning, true);
    });

    it("parses --follow and -f", () => {
      const result1 = parseCliArgs(["--follow", "log"]);
      assert.strictEqual(result1.flags.follow, true);

      const result2 = parseCliArgs(["-f", "log"]);
      assert.strictEqual(result2.flags.follow, true);
    });

    it("parses --all", () => {
      const result = parseCliArgs(["--all", "mailbox"]);
      assert.strictEqual(result.flags.all, true);
    });

    it("parses --version and -V", () => {
      const result1 = parseCliArgs(["--version"]);
      assert.strictEqual(result1.flags.version, true);

      const result2 = parseCliArgs(["-V"]);
      assert.strictEqual(result2.flags.version, true);
    });

    it("parses --help and -h", () => {
      const result1 = parseCliArgs(["--help"]);
      assert.strictEqual(result1.flags.help, true);

      const result2 = parseCliArgs(["-h"]);
      assert.strictEqual(result2.flags.help, true);
    });
  });

  describe("value flags", () => {
    it("parses --tool=value", () => {
      const result = parseCliArgs(["--tool=claude", "message"]);
      assert.strictEqual(result.flags.tool, "claude");
    });

    it("parses --session=value", () => {
      const result = parseCliArgs(["--session=abc123", "status"]);
      assert.strictEqual(result.flags.session, "abc123");
    });

    it("parses --timeout=value as number", () => {
      const result = parseCliArgs(["--timeout=30", "message"]);
      assert.strictEqual(result.flags.timeout, 30);
    });

    it("parses --tail=value as number", () => {
      const result = parseCliArgs(["--tail=50", "log"]);
      assert.strictEqual(result.flags.tail, 50);
    });

    it("parses --limit=value as number", () => {
      const result = parseCliArgs(["--limit=10", "mailbox"]);
      assert.strictEqual(result.flags.limit, 10);
    });

    it("parses --branch=value", () => {
      const result = parseCliArgs(["--branch=feature/foo", "mailbox"]);
      assert.strictEqual(result.flags.branch, "feature/foo");
    });
  });

  describe("positionals", () => {
    it("extracts command as first positional", () => {
      const result = parseCliArgs(["agents"]);
      assert.deepStrictEqual(result.positionals, ["agents"]);
    });

    it("extracts message as positional", () => {
      const result = parseCliArgs(["hello world"]);
      assert.deepStrictEqual(result.positionals, ["hello world"]);
    });

    it("flags do not appear in positionals", () => {
      const result = parseCliArgs(["--fresh", "--tool=claude", "hello"]);
      assert.deepStrictEqual(result.positionals, ["hello"]);
    });

    it("handles flags in any order", () => {
      const result1 = parseCliArgs(["--fresh", "message"]);
      const result2 = parseCliArgs(["message", "--fresh"]);

      assert.strictEqual(result1.flags.fresh, true);
      assert.strictEqual(result2.flags.fresh, true);
      assert.deepStrictEqual(result1.positionals, ["message"]);
      assert.deepStrictEqual(result2.positionals, ["message"]);
    });

    it("handles multiple positionals", () => {
      const result = parseCliArgs(["send", "hello", "world"]);
      assert.deepStrictEqual(result.positionals, ["send", "hello", "world"]);
    });
  });

  describe("edge cases", () => {
    it("returns empty positionals for flags only", () => {
      const result = parseCliArgs(["--version"]);
      assert.deepStrictEqual(result.positionals, []);
    });

    it("handles empty args", () => {
      const result = parseCliArgs([]);
      assert.deepStrictEqual(result.positionals, []);
      assert.strictEqual(result.flags.wait, false);
    });

    it("defaults boolean flags to false", () => {
      const result = parseCliArgs(["message"]);
      assert.strictEqual(result.flags.wait, false);
      assert.strictEqual(result.flags.noWait, false);
      assert.strictEqual(result.flags.yolo, false);
      assert.strictEqual(result.flags.fresh, false);
    });

    it("defaults value flags to undefined", () => {
      const result = parseCliArgs(["message"]);
      assert.strictEqual(result.flags.tool, undefined);
      assert.strictEqual(result.flags.session, undefined);
      assert.strictEqual(result.flags.timeout, undefined);
    });
  });
});

describe("parseSessionName", () => {
  it("parses partner session with uuid", () => {
    const result = parseSessionName("claude-partner-12345678-1234-1234-1234-123456789abc");
    assert.deepStrictEqual(result, {
      tool: "claude",
      uuid: "12345678-1234-1234-1234-123456789abc",
    });
  });

  it("parses archangel session with name and uuid", () => {
    const result = parseSessionName("claude-archangel-myagent-12345678-1234-1234-1234-123456789abc");
    assert.deepStrictEqual(result, {
      tool: "claude",
      archangelName: "myagent",
      uuid: "12345678-1234-1234-1234-123456789abc",
    });
  });

  it("parses basic tool session without uuid", () => {
    const result = parseSessionName("codex-something");
    assert.deepStrictEqual(result, { tool: "codex" });
  });

  it("returns null for invalid session", () => {
    assert.strictEqual(parseSessionName("invalid"), null);
    assert.strictEqual(parseSessionName("random-string"), null);
  });
});

describe("parseAgentConfig", () => {
  it("parses valid config with frontmatter", () => {
    const content = `---
tool: claude
watch: ["src/**/*.ts"]
interval: 60
---
Review for edge cases...`;
    const result = parseAgentConfig("test.md", content);
    assert.strictEqual(result.name, "test");
    assert.strictEqual(result.tool, "claude");
    assert.deepStrictEqual(result.watch, ["src/**/*.ts"]);
    assert.strictEqual(result.interval, 60);
    assert.strictEqual(result.prompt, "Review for edge cases...");
  });

  it("defaults to codex if tool not specified", () => {
    const content = `---
watch: ["*.js"]
interval: 30
---
Check for issues`;
    const result = parseAgentConfig("agent.md", content);
    assert.strictEqual(result.tool, "codex");
  });

  it("returns error for missing frontmatter", () => {
    const content = `No frontmatter here`;
    const result = parseAgentConfig("bad.md", content);
    assert.ok("error" in result);
  });

  it("clamps interval to valid range", () => {
    const content = `---
watch: ["*.js"]
interval: 5
---
Prompt`;
    const result = parseAgentConfig("test.md", content);
    assert.strictEqual(result.interval, 10); // min is 10
  });

  it("returns error for unknown field (typo detection)", () => {
    const content = `---
tol: claude
watch: ["*.js"]
---
Prompt`;
    const result = parseAgentConfig("test.md", content);
    assert.ok("error" in result);
    assert.ok(result.error.includes("Unknown field 'tol'"));
    assert.ok(result.error.includes("tool")); // suggests correct field
  });

  it("returns error for invalid interval", () => {
    const content = `---
watch: ["*.js"]
interval: abc
---
Prompt`;
    const result = parseAgentConfig("test.md", content);
    assert.ok("error" in result);
    assert.ok(result.error.includes("Invalid interval"));
  });

  it("returns error for watch without array brackets", () => {
    const content = `---
watch: src/**/*.ts
---
Prompt`;
    const result = parseAgentConfig("test.md", content);
    assert.ok("error" in result);
    assert.ok(result.error.includes("Must be an array"));
  });

  it("returns error for empty watch array", () => {
    const content = `---
watch: []
---
Prompt`;
    const result = parseAgentConfig("test.md", content);
    assert.ok("error" in result);
    assert.ok(result.error.includes("Empty watch array"));
  });

  it("accepts exclusion patterns with ! prefix", () => {
    const content = `---
watch: ["**/*.ts", "!vendor/**"]
---
Prompt`;
    const result = parseAgentConfig("test.md", content);
    assert.ok(!("error" in result));
    assert.deepStrictEqual(result.watch, ["**/*.ts", "!vendor/**"]);
  });
});

describe("parseKeySequence", () => {
  it("parses Enter key", () => {
    const result = parseKeySequence("[Enter]");
    assert.deepStrictEqual(result, [{ type: "key", value: "Enter" }]);
  });

  it("parses Escape key", () => {
    const result = parseKeySequence("[Escape]");
    assert.deepStrictEqual(result, [{ type: "key", value: "Escape" }]);
  });

  it("parses multiple keys", () => {
    const result = parseKeySequence("[Escape][Enter]");
    assert.deepStrictEqual(result, [
      { type: "key", value: "Escape" },
      { type: "key", value: "Enter" },
    ]);
  });

  it("parses mixed text and keys", () => {
    const result = parseKeySequence("hello[Enter]");
    assert.deepStrictEqual(result, [
      { type: "literal", value: "hello" },
      { type: "key", value: "Enter" },
    ]);
  });

  it("parses number followed by Enter", () => {
    const result = parseKeySequence("1[Enter]");
    assert.deepStrictEqual(result, [
      { type: "literal", value: "1" },
      { type: "key", value: "Enter" },
    ]);
  });
});

describe("getClaudeProjectPath", () => {
  it("converts absolute path to relative with dash separators", () => {
    const result = getClaudeProjectPath("/Users/test/projects/myapp");
    assert.strictEqual(result, "-Users-test-projects-myapp");
  });
});

describe("matchesPattern", () => {
  it("matches exact filename", () => {
    assert.ok(matchesPattern("test.js", "test.js"));
  });

  it("matches wildcard extension", () => {
    assert.ok(matchesPattern("test.js", "*.js"));
    assert.ok(matchesPattern("foo.ts", "*.ts"));
  });

  it("matches double star glob", () => {
    assert.ok(matchesPattern("src/components/Button.tsx", "src/**/*.tsx"));
    assert.ok(matchesPattern("src/deep/nested/file.tsx", "src/**/*.tsx"));
  });

  it("rejects non-matching patterns", () => {
    assert.ok(!matchesPattern("test.ts", "*.js"));
    assert.ok(!matchesPattern("other/file.tsx", "src/**/*.tsx"));
  });
});

describe("getBaseDir", () => {
  it("extracts base directory from glob pattern", () => {
    assert.strictEqual(getBaseDir("src/**/*.ts"), "src");
    assert.strictEqual(getBaseDir("lib/components/**/*.tsx"), "lib/components");
  });

  it("returns dot for patterns starting with wildcard", () => {
    assert.strictEqual(getBaseDir("*.js"), ".");
    assert.strictEqual(getBaseDir("**/*.ts"), ".");
  });
});

describe("truncate", () => {
  it("returns string unchanged if under limit", () => {
    assert.strictEqual(truncate("short", 100), "short");
  });

  it("truncates with ellipsis", () => {
    const result = truncate("this is a long string", 10);
    assert.strictEqual(result, "this is a ..."); // 10 chars + "..."
  });

  it("returns empty string for falsy input", () => {
    assert.strictEqual(truncate("", 10), "");
    assert.strictEqual(truncate(null, 10), "");
  });
});

describe("truncateDiff", () => {
  it("returns diff unchanged if under line limit", () => {
    const diff = "line1\nline2\nline3";
    assert.strictEqual(truncateDiff(diff, 10), diff);
  });

  it("truncates with message if over limit", () => {
    const diff = "line1\nline2\nline3\nline4\nline5";
    const result = truncateDiff(diff, 3);
    assert.ok(result.includes("line1"));
    assert.ok(result.includes("truncated"));
  });
});

describe("extractTextContent", () => {
  it("extracts text from string content", () => {
    assert.strictEqual(extractTextContent("hello"), "hello");
  });

  it("extracts text from array with text blocks joined by newline", () => {
    const content = [
      { type: "text", text: "Hello" },
      { type: "text", text: "world" },
    ];
    assert.strictEqual(extractTextContent(content), "Hello\nworld");
  });

  it("returns empty string for array with no text content", () => {
    const content = [{ type: "tool_use", name: "read" }];
    assert.strictEqual(extractTextContent(content), "");
  });

  it("returns null for non-matching content", () => {
    assert.strictEqual(extractTextContent(123), null);
  });
});

describe("extractToolCalls", () => {
  it("extracts tool calls from content array", () => {
    const content = [
      { type: "text", text: "Let me read that" },
      { type: "tool_use", name: "Read", input: { path: "/test/file.js" } },
    ];
    const result = extractToolCalls(content);
    assert.strictEqual(result.length, 1);
    assert.strictEqual(result[0].name, "Read");
    assert.strictEqual(result[0].target, "file.js");
  });

  it("returns empty array for no tool calls", () => {
    const content = [{ type: "text", text: "Just text" }];
    assert.deepStrictEqual(extractToolCalls(content), []);
  });

  it("returns empty array for non-array input", () => {
    assert.deepStrictEqual(extractToolCalls("string"), []);
    assert.deepStrictEqual(extractToolCalls(null), []);
  });
});

describe("extractThinking", () => {
  it("extracts thinking from content array", () => {
    const content = [
      { type: "thinking", thinking: "Let me consider..." },
      { type: "text", text: "Here's my answer" },
    ];
    const result = extractThinking(content);
    assert.strictEqual(result, "Let me consider...");
  });

  it("returns null for no thinking", () => {
    const content = [{ type: "text", text: "Direct answer" }];
    assert.strictEqual(extractThinking(content), null);
  });

  it("returns null for non-array input", () => {
    assert.strictEqual(extractThinking("string"), null);
  });
});

// =============================================================================
// detectState - the core state machine
// =============================================================================

// Use real agent configs for testing (no duplication)
const claudeConfig = ClaudeAgent;
const codexConfig = CodexAgent;

describe("detectState", () => {
  describe("STARTING state", () => {
    it("returns STARTING for empty screen", () => {
      assert.strictEqual(detectState("", claudeConfig), State.STARTING);
      assert.strictEqual(detectState(null, claudeConfig), State.STARTING);
    });

    it("returns STARTING when no patterns match", () => {
      const screen = `Some random text
that doesn't match any patterns
at all`;
      assert.strictEqual(detectState(screen, claudeConfig), State.STARTING);
    });
  });

  describe("READY state", () => {
    it("detects ready when prompt symbol in last lines (Claude)", () => {
      const screen = `Previous output here

Some response from Claude

❯ `;
      assert.strictEqual(detectState(screen, claudeConfig), State.READY);
    });

    it("detects ready when prompt symbol in last lines (Codex)", () => {
      const screen = `Previous output here

Some response from Codex

› `;
      assert.strictEqual(detectState(screen, codexConfig), State.READY);
    });

    it("NOT ready when prompt has pasted text indicator", () => {
      const screen = `Previous output

❯ [Pasted text +500 lines]`;
      // With activeWorkPatterns (claudeConfig has it), [Pasted text triggers THINKING
      assert.strictEqual(detectState(screen, claudeConfig), State.THINKING);
      // Without activeWorkPatterns, prompt symbol causes READY
      const configNoActiveWork = { ...claudeConfig, activeWorkPatterns: [] };
      assert.strictEqual(detectState(screen, configNoActiveWork), State.READY);
    });
  });

  describe("THINKING state", () => {
    it("detects thinking from spinner character", () => {
      // Claude uses ·✢✳✶✻✽ spinners, Codex uses braille ⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏
      const screen = `Working on your request

✢ Processing files...

Some status`;
      assert.strictEqual(detectState(screen, claudeConfig), State.THINKING);
    });

    it("detects thinking from text pattern (Claude)", () => {
      // No prompt symbol - agent is actively thinking
      const screen = `Some context

Thinking`;
      // This tests the thinkingPatterns check (spinners disabled)
      const configNoSpinners = { ...claudeConfig, spinners: [] };
      assert.strictEqual(detectState(screen, configNoSpinners), State.THINKING);
    });

    it("detects thinking from text pattern (Codex)", () => {
      const screen = `Working on it

Thinking…`;
      const configNoSpinners = { ...codexConfig, spinners: [] };
      assert.strictEqual(detectState(screen, configNoSpinners), State.THINKING);
    });
  });

  describe("CONFIRMING state", () => {
    it("detects confirmation from string pattern", () => {
      const screen = `I'll make this change for you.

Do you want to proceed?
Press y to confirm`;
      assert.strictEqual(detectState(screen, claudeConfig), State.CONFIRMING);
    });

    it("detects confirmation from function pattern (Claude menu)", () => {
      const screen = `Ready to execute the command.

1. Yes
2. No

Select an option:`;
      assert.strictEqual(detectState(screen, claudeConfig), State.CONFIRMING);
    });

    it("detects confirmation from function pattern (Codex y/n)", () => {
      const screen = `Apply this change?

[y] Yes  [n] No`;
      assert.strictEqual(detectState(screen, codexConfig), State.CONFIRMING);
    });

    it("detects Codex Run command prompt", () => {
      const screen = `About to execute:
npm test

Run command?`;
      assert.strictEqual(detectState(screen, codexConfig), State.CONFIRMING);
    });

    it("only checks recent lines to avoid false positives from history", () => {
      // Confirmation in old history should NOT trigger
      const screen = `Old conversation:
Do you want to proceed?
User said yes.

${"x\n".repeat(20)}

All done!
❯ `;
      assert.strictEqual(detectState(screen, claudeConfig), State.READY);
    });
  });

  describe("RATE_LIMITED state", () => {
    it("detects rate limit (Claude)", () => {
      const screen = `Sorry, you've hit a rate limit. Please try again later.

❯ `;
      assert.strictEqual(detectState(screen, claudeConfig), State.RATE_LIMITED);
    });

    it("detects rate limit (Codex)", () => {
      const screen = `■ Usage limit exceeded. Please try again at 3:00 PM

› `;
      assert.strictEqual(detectState(screen, codexConfig), State.RATE_LIMITED);
    });

    it("rate limit takes priority over ready", () => {
      const screen = `Rate limit exceeded

❯ `;
      assert.strictEqual(detectState(screen, claudeConfig), State.RATE_LIMITED);
    });
  });

  describe("UPDATE_PROMPT state", () => {
    it("detects update prompt (Codex)", () => {
      const screen = `Update available: v1.2.3

What's new:
- Bug fixes
- Performance improvements

Skip    Install`;
      assert.strictEqual(detectState(screen, codexConfig), State.UPDATE_PROMPT);
    });

    it("requires both screen and lastLines patterns to match", () => {
      // Only screen pattern matches, not lastLines
      const screen = `Update available: v1.2.3

Some other content
› `;
      assert.strictEqual(detectState(screen, codexConfig), State.READY);
    });
  });

  describe("FEEDBACK_MODAL state", () => {
    it("detects Claude feedback modal", () => {
      const screen = `Done processing your request.

● How is Claude doing this session? (optional)
  1: Bad    2: Fine   3: Good   0: Dismiss`;
      assert.strictEqual(detectState(screen, claudeConfig), State.FEEDBACK_MODAL);
    });

    it("detects feedback modal with varying whitespace", () => {
      const screen = `● How is Claude doing this session? (optional)
  1:Bad 2:Fine 3:Good 0:Dismiss`;
      assert.strictEqual(detectState(screen, claudeConfig), State.FEEDBACK_MODAL);
    });

    it("does not match partial options", () => {
      // Missing some options should NOT trigger
      const screen = `1: Bad  2: Fine
❯ `;
      assert.strictEqual(detectState(screen, claudeConfig), State.READY);
    });

    it("feedback modal beats confirming", () => {
      const screen = `Do you want to proceed?
1: Bad  2: Fine  3: Good  0: Dismiss`;
      assert.strictEqual(detectState(screen, claudeConfig), State.FEEDBACK_MODAL);
    });
  });

  describe("priority order", () => {
    it("rate limit beats everything", () => {
      const screen = `Rate limit hit
⠋ Still spinning
Do you want to proceed?
❯ `;
      assert.strictEqual(detectState(screen, claudeConfig), State.RATE_LIMITED);
    });

    it("rate limit beats feedback modal", () => {
      const screen = `Rate limit exceeded
How is Claude doing this session?
1: Bad  2: Fine  3: Good  0: Dismiss`;
      assert.strictEqual(detectState(screen, claudeConfig), State.RATE_LIMITED);
    });

    it("confirming beats thinking (Running… in tool output shouldn't block confirmation)", () => {
      const screen = `⠋ Working
Do you want to proceed?
❯ `;
      assert.strictEqual(detectState(screen, claudeConfig), State.CONFIRMING);
    });

    it("confirming beats ready", () => {
      const screen = `Do you want to proceed?
❯ `;
      assert.strictEqual(detectState(screen, claudeConfig), State.CONFIRMING);
    });

    it("ready beats thinking when prompt visible (spinner in timing message)", () => {
      // Real scenario: Claude shows "✻ Worked for 45s" timing message after completing
      // The ✻ character is a spinner, but the prompt ❯ is visible so it's ready
      const screen = `Want me to remove this item from TODO.md?

✻ Worked for 45s

❯ `;
      assert.strictEqual(detectState(screen, claudeConfig), State.READY);
    });
  });
});

// =============================================================================
// Permission utilities
// =============================================================================

describe("normalizeAllowedTools", () => {
  it("normalizes whitespace and sorts tools", () => {
    assert.strictEqual(normalizeAllowedTools('Bash("npm *")  Bash("cargo *")'), 'Bash("cargo *") Bash("npm *")');
  });

  it("handles single tool", () => {
    assert.strictEqual(normalizeAllowedTools('Bash("cargo *")'), 'Bash("cargo *")');
  });

  it("trims leading/trailing whitespace", () => {
    assert.strictEqual(normalizeAllowedTools('  Bash("cargo *")  '), 'Bash("cargo *")');
  });

  it("handles multiple spaces between tools", () => {
    assert.strictEqual(normalizeAllowedTools('Bash("a")    Bash("b")'), 'Bash("a") Bash("b")');
  });

  it("handles tools without arguments", () => {
    assert.strictEqual(normalizeAllowedTools("Write Read Grep"), "Grep Read Write");
  });

  it("handles mixed tools with and without arguments", () => {
    assert.strictEqual(normalizeAllowedTools('Read Bash("npm *")'), 'Bash("npm *") Read');
  });
});

describe("computePermissionHash", () => {
  it("returns null for null/undefined input", () => {
    assert.strictEqual(computePermissionHash(null), null);
    assert.strictEqual(computePermissionHash(undefined), null);
  });

  it("returns null for empty string", () => {
    assert.strictEqual(computePermissionHash(""), null);
  });

  it("returns 8-char hex hash", () => {
    const hash = computePermissionHash('Bash("cargo *")');
    assert.match(hash, /^[0-9a-f]{8}$/);
  });

  it("same tools in different order produce same hash", () => {
    const hash1 = computePermissionHash('Bash("npm *") Bash("cargo *")');
    const hash2 = computePermissionHash('Bash("cargo *") Bash("npm *")');
    assert.strictEqual(hash1, hash2);
  });

  it("different tools produce different hashes", () => {
    const hash1 = computePermissionHash('Bash("cargo *")');
    const hash2 = computePermissionHash('Bash("npm *")');
    assert.notStrictEqual(hash1, hash2);
  });
});

describe("parseSessionName with permission modes", () => {
  it("parses partner session with permission hash", () => {
    const result = parseSessionName("claude-partner-12345678-1234-1234-1234-123456789abc-pabcd1234");
    assert.deepStrictEqual(result, {
      tool: "claude",
      uuid: "12345678-1234-1234-1234-123456789abc",
      permissionHash: "abcd1234",
    });
  });

  it("parses partner session with yolo suffix", () => {
    const result = parseSessionName("claude-partner-12345678-1234-1234-1234-123456789abc-yolo");
    assert.deepStrictEqual(result, {
      tool: "claude",
      uuid: "12345678-1234-1234-1234-123456789abc",
      yolo: true,
    });
  });

  it("parses partner session without suffix (safe mode)", () => {
    const result = parseSessionName("claude-partner-12345678-1234-1234-1234-123456789abc");
    assert.deepStrictEqual(result, {
      tool: "claude",
      uuid: "12345678-1234-1234-1234-123456789abc",
    });
  });

  it("parses archangel sessions", () => {
    const result = parseSessionName("claude-archangel-reviewer-12345678-1234-1234-1234-123456789abc");
    assert.deepStrictEqual(result, {
      tool: "claude",
      archangelName: "reviewer",
      uuid: "12345678-1234-1234-1234-123456789abc",
    });
  });
});

describe("parseCliArgs with --auto-approve", () => {
  it("parses --auto-approve flag", () => {
    const result = parseCliArgs(['--auto-approve=Bash("cargo *")', "run tests"]);
    assert.strictEqual(result.flags.autoApprove, 'Bash("cargo *")');
  });

  it("auto-approve is undefined when not provided", () => {
    const result = parseCliArgs(["run tests"]);
    assert.strictEqual(result.flags.autoApprove, undefined);
  });
});

// =============================================================================
// formatClaudeLogEntry - Claude Code log entry formatting
// =============================================================================

describe("formatClaudeLogEntry", () => {
  it("returns null for tool_result entries", () => {
    const entry = { type: "tool_result", content: "some result" };
    assert.strictEqual(formatClaudeLogEntry(entry), null);
  });

  it("returns null for non-assistant entries", () => {
    const entry = { type: "user", message: { content: [{ type: "text", text: "hello" }] } };
    assert.strictEqual(formatClaudeLogEntry(entry), null);
  });

  it("extracts text from assistant entry", () => {
    const entry = {
      type: "assistant",
      message: { content: [{ type: "text", text: "Hello world" }] },
    };
    assert.strictEqual(formatClaudeLogEntry(entry), "Hello world");
  });

  it("joins multiple text parts with newline", () => {
    const entry = {
      type: "assistant",
      message: {
        content: [
          { type: "text", text: "Line 1" },
          { type: "text", text: "Line 2" },
        ],
      },
    };
    assert.strictEqual(formatClaudeLogEntry(entry), "Line 1\nLine 2");
  });

  it("formats tool_use as summary", () => {
    const entry = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Read", input: { file_path: "/path/to/file.js" } }],
      },
    };
    assert.strictEqual(formatClaudeLogEntry(entry), "> Read(file.js)");
  });

  it("formats Bash tool with command snippet", () => {
    const entry = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: "npm install && npm test" } }],
      },
    };
    assert.strictEqual(formatClaudeLogEntry(entry), "> Bash(npm install && npm test)");
  });

  it("truncates long Bash commands", () => {
    const longCommand = "a".repeat(100);
    const entry = {
      type: "assistant",
      message: {
        content: [{ type: "tool_use", name: "Bash", input: { command: longCommand } }],
      },
    };
    const result = formatClaudeLogEntry(entry);
    assert.ok(result.startsWith("> Bash("));
    assert.ok(result.length < 70); // 50 char command + "> Bash()"
  });

  it("handles tool_call type (alternative format)", () => {
    const entry = {
      type: "assistant",
      message: {
        content: [{ type: "tool_call", tool: "Grep", arguments: { pattern: "TODO" } }],
      },
    };
    // pattern field is extracted as target
    assert.strictEqual(formatClaudeLogEntry(entry), "> Grep(TODO)");
  });

  it("returns null for empty content", () => {
    const entry = { type: "assistant", message: { content: [] } };
    assert.strictEqual(formatClaudeLogEntry(entry), null);
  });

  it("includes thinking blocks (extended thinking models put responses here)", () => {
    const entry = {
      type: "assistant",
      message: {
        content: [
          { type: "thinking", thinking: "Let me think..." },
          { type: "text", text: "Here's my answer" },
        ],
      },
    };
    assert.strictEqual(formatClaudeLogEntry(entry), "Let me think...\nHere's my answer");
  });
});

// =============================================================================
// formatCodexLogEntry - Codex log entry formatting
// =============================================================================

describe("formatCodexLogEntry", () => {
  it("returns null for function_call_output entries", () => {
    const entry = {
      type: "response_item",
      payload: { type: "function_call_output", output: "result" },
    };
    assert.strictEqual(formatCodexLogEntry(entry), null);
  });

  it("formats function_call with shell_command", () => {
    const entry = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "shell_command",
        arguments: JSON.stringify({ command: "git status", workdir: "/test" }),
      },
    };
    assert.strictEqual(formatCodexLogEntry(entry), "> shell_command(git status)");
  });

  it("formats function_call with file path", () => {
    const entry = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "read_file",
        arguments: JSON.stringify({ file_path: "/path/to/file.js" }),
      },
    };
    assert.strictEqual(formatCodexLogEntry(entry), "> read_file(file.js)");
  });

  it("handles malformed JSON in arguments", () => {
    const entry = {
      type: "response_item",
      payload: {
        type: "function_call",
        name: "some_tool",
        arguments: "not valid json",
      },
    };
    assert.strictEqual(formatCodexLogEntry(entry), "> some_tool(...)");
  });

  it("extracts text from assistant message with output_text", () => {
    const entry = {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Here is my response" }],
      },
    };
    assert.strictEqual(formatCodexLogEntry(entry), "Here is my response");
  });

  it("extracts text from assistant message with text type", () => {
    const entry = {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: "Alternative format" }],
      },
    };
    assert.strictEqual(formatCodexLogEntry(entry), "Alternative format");
  });

  it("returns null for non-assistant messages", () => {
    const entry = {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "User message" }],
      },
    };
    assert.strictEqual(formatCodexLogEntry(entry), null);
  });

  it("handles agent_message event for streaming", () => {
    const entry = {
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: "Streaming response text",
      },
    };
    assert.strictEqual(formatCodexLogEntry(entry), "Streaming response text");
  });

  it("returns null for other event_msg types", () => {
    const entry = {
      type: "event_msg",
      payload: { type: "token_count", count: 100 },
    };
    assert.strictEqual(formatCodexLogEntry(entry), null);
  });

  it("returns null for unknown entry types", () => {
    const entry = { type: "session_meta", payload: { id: "123" } };
    assert.strictEqual(formatCodexLogEntry(entry), null);
  });

  it("returns null for empty assistant content", () => {
    const entry = {
      type: "response_item",
      payload: { type: "message", role: "assistant", content: [] },
    };
    assert.strictEqual(formatCodexLogEntry(entry), null);
  });
});

// =============================================================================
// detectState with activeWorkPatterns
// =============================================================================

describe("detectState with activeWorkPatterns", () => {
  const codexConfigWithActiveWork = {
    promptSymbol: "›",
    spinners: [],
    thinkingPatterns: ["Thinking…"],
    activeWorkPatterns: ["esc to interrupt"],
    confirmPatterns: [],
    updatePromptPatterns: null,
  };

  const claudeConfigWithActiveWork = {
    promptSymbol: "❯",
    spinners: [],
    thinkingPatterns: ["Thinking"],
    activeWorkPatterns: ["[Pasted text"],
    confirmPatterns: [],
    updatePromptPatterns: null,
  };

  it("detects THINKING when activeWorkPattern matches (Codex)", () => {
    const screen = `Working on your request

• Planning approach (5s • esc to interrupt)

› Implement {feature}`;
    assert.strictEqual(detectState(screen, codexConfigWithActiveWork), State.THINKING);
  });

  it("detects READY when no activeWorkPattern matches (Codex)", () => {
    const screen = `Done with the task

› `;
    assert.strictEqual(detectState(screen, codexConfigWithActiveWork), State.READY);
  });

  it("detects THINKING when activeWorkPattern matches (Claude)", () => {
    const screen = `Processing your input

❯ [Pasted text +500 lines]`;
    assert.strictEqual(detectState(screen, claudeConfigWithActiveWork), State.THINKING);
  });

  it("detects READY when no activeWorkPattern matches (Claude)", () => {
    const screen = `Here's my response

❯ `;
    assert.strictEqual(detectState(screen, claudeConfigWithActiveWork), State.READY);
  });

  it("activeWorkPatterns supports regex", () => {
    const configWithRegex = {
      ...codexConfigWithActiveWork,
      activeWorkPatterns: [/\d+s • esc/],
    };
    const screen = `Working

• Thinking (15s • esc to interrupt)

› template`;
    assert.strictEqual(detectState(screen, configWithRegex), State.THINKING);
  });

  it("activeWorkPatterns takes priority over prompt symbol", () => {
    // Even though prompt symbol is present, activeWorkPattern should win
    const screen = `Processing

• Working (3s • esc to interrupt)

› `;
    assert.strictEqual(detectState(screen, codexConfigWithActiveWork), State.THINKING);
  });

  it("empty activeWorkPatterns allows normal READY detection", () => {
    const configNoActiveWork = {
      ...codexConfigWithActiveWork,
      activeWorkPatterns: [],
    };
    const screen = `Some output

› `;
    assert.strictEqual(detectState(screen, configNoActiveWork), State.READY);
  });
});

// =============================================================================
// Terminal Stream Primitives - parseJsonlEntry, parseScreenLines, findMatch
// =============================================================================

describe("parseJsonlEntry", () => {
  describe("claude format", () => {
    it("parses assistant text entry into TerminalLine[]", () => {
      const entry = {
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello world" }] },
      };
      const lines = parseJsonlEntry(entry, "claude");
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].raw, "Hello world");
      assert.deepStrictEqual(lines[0].spans, [{ text: "Hello world" }]);
    });

    it("splits multiline text into multiple TerminalLine[]", () => {
      const entry = {
        type: "assistant",
        message: { content: [{ type: "text", text: "Line 1\nLine 2\nLine 3" }] },
      };
      const lines = parseJsonlEntry(entry, "claude");
      assert.strictEqual(lines.length, 3);
      assert.strictEqual(lines[0].raw, "Line 1");
      assert.strictEqual(lines[1].raw, "Line 2");
      assert.strictEqual(lines[2].raw, "Line 3");
    });

    it("returns empty array for tool_result entries", () => {
      const entry = { type: "tool_result", content: "some result" };
      const lines = parseJsonlEntry(entry, "claude");
      assert.deepStrictEqual(lines, []);
    });

    it("formats tool_use entry", () => {
      const entry = {
        type: "assistant",
        message: {
          content: [{ type: "tool_use", name: "Read", input: { file_path: "/path/to/file.js" } }],
        },
      };
      const lines = parseJsonlEntry(entry, "claude");
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].raw, "> Read(file.js)");
    });
  });

  describe("codex format", () => {
    it("parses assistant message into TerminalLine[]", () => {
      const entry = {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Hello from Codex" }],
        },
      };
      const lines = parseJsonlEntry(entry, "codex");
      assert.strictEqual(lines.length, 1);
      assert.strictEqual(lines[0].raw, "Hello from Codex");
    });

    it("returns empty array for function_call_output entries", () => {
      const entry = {
        type: "response_item",
        payload: { type: "function_call_output", output: "result" },
      };
      const lines = parseJsonlEntry(entry, "codex");
      assert.deepStrictEqual(lines, []);
    });
  });
});

describe("parseScreenLines", () => {
  it("parses screen into TerminalLine[]", () => {
    const screen = "Line 1\nLine 2\nLine 3";
    const lines = parseScreenLines(screen);
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[0].raw, "Line 1");
    assert.strictEqual(lines[1].raw, "Line 2");
    assert.strictEqual(lines[2].raw, "Line 3");
  });

  it("creates unstyled spans for each line", () => {
    const screen = "Hello world";
    const lines = parseScreenLines(screen);
    assert.strictEqual(lines.length, 1);
    assert.deepStrictEqual(lines[0].spans, [{ text: "Hello world" }]);
  });

  it("returns empty array for empty screen", () => {
    assert.deepStrictEqual(parseScreenLines(""), []);
    assert.deepStrictEqual(parseScreenLines(null), []);
    assert.deepStrictEqual(parseScreenLines(undefined), []);
  });

  it("preserves empty lines", () => {
    const screen = "Line 1\n\nLine 3";
    const lines = parseScreenLines(screen);
    assert.strictEqual(lines.length, 3);
    assert.strictEqual(lines[1].raw, "");
  });
});

describe("findMatch", () => {
  const sampleLines = [
    { spans: [{ text: "Hello world" }], raw: "Hello world" },
    { spans: [{ text: "Error: something failed" }], raw: "Error: something failed" },
    { spans: [{ text: "Ready prompt ❯" }], raw: "Ready prompt ❯" },
  ];

  describe("string pattern matching", () => {
    it("finds exact string match", () => {
      const result = findMatch(sampleLines, { pattern: "Error" });
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.lineIndex, 1);
      assert.strictEqual(result.line.raw, "Error: something failed");
    });

    it("returns first match when multiple lines match", () => {
      const lines = [
        { spans: [{ text: "test 1" }], raw: "test 1" },
        { spans: [{ text: "test 2" }], raw: "test 2" },
      ];
      const result = findMatch(lines, { pattern: "test" });
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.lineIndex, 0);
    });

    it("returns no match when pattern not found", () => {
      const result = findMatch(sampleLines, { pattern: "nonexistent" });
      assert.strictEqual(result.matched, false);
      assert.strictEqual(result.line, undefined);
      assert.strictEqual(result.lineIndex, undefined);
    });
  });

  describe("regex pattern matching", () => {
    it("matches regex pattern", () => {
      const result = findMatch(sampleLines, { pattern: /Error:\s+\w+/ });
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.lineIndex, 1);
    });

    it("matches regex with special characters", () => {
      const result = findMatch(sampleLines, { pattern: /❯$/ });
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.lineIndex, 2);
    });

    it("returns no match for non-matching regex", () => {
      const result = findMatch(sampleLines, { pattern: /^\d+$/ });
      assert.strictEqual(result.matched, false);
    });
  });

  describe("style filtering", () => {
    it("ignores style filter when lines have no style info", () => {
      // Lines without style info should match based on pattern only
      const result = findMatch(sampleLines, {
        pattern: "Error",
        style: { fg: "red" },
      });
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.lineIndex, 1);
    });

    it("matches style when lines have style info", () => {
      const styledLines = [
        { spans: [{ text: "Normal text" }], raw: "Normal text" },
        { spans: [{ text: "Error", style: { fg: "red" } }], raw: "Error" },
      ];
      const result = findMatch(styledLines, {
        pattern: "Error",
        style: { fg: "red" },
      });
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.lineIndex, 1);
    });

    it("does not match when style differs", () => {
      const styledLines = [
        { spans: [{ text: "Error", style: { fg: "green" } }], raw: "Error" },
      ];
      const result = findMatch(styledLines, {
        pattern: "Error",
        style: { fg: "red" },
      });
      // Style filter applies only when both have style info
      // The span has style but it doesn't match, so no match
      assert.strictEqual(result.matched, false);
    });

    it("matches partial style requirements", () => {
      const styledLines = [
        {
          spans: [{ text: "Bold red error", style: { fg: "red", bold: true } }],
          raw: "Bold red error",
        },
      ];
      // Only require fg: red, don't care about bold
      const result = findMatch(styledLines, {
        pattern: "error",
        style: { fg: "red" },
      });
      assert.strictEqual(result.matched, true);
    });
  });

  describe("edge cases", () => {
    it("handles empty lines array", () => {
      const result = findMatch([], { pattern: "anything" });
      assert.strictEqual(result.matched, false);
    });

    it("handles empty pattern", () => {
      const result = findMatch(sampleLines, { pattern: "" });
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.lineIndex, 0);
    });
  });
});

// =============================================================================
// Terminal Stream Implementations
// =============================================================================

describe("FakeTerminalStream", () => {
  describe("static helpers", () => {
    it("creates a single TerminalLine from string", () => {
      const line = FakeTerminalStream.line("Hello world");
      assert.strictEqual(line.raw, "Hello world");
      assert.deepStrictEqual(line.spans, [{ text: "Hello world" }]);
    });

    it("creates multiple TerminalLines from strings", () => {
      const lines = FakeTerminalStream.lines(["Line 1", "Line 2"]);
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[0].raw, "Line 1");
      assert.strictEqual(lines[1].raw, "Line 2");
    });
  });

  describe("readNext", () => {
    it("returns initial lines on first call", async () => {
      const stream = new FakeTerminalStream(FakeTerminalStream.lines(["Hello", "World"]));
      const lines = await stream.readNext();
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[0].raw, "Hello");
    });

    it("returns empty array on subsequent calls without queued lines", async () => {
      const stream = new FakeTerminalStream(FakeTerminalStream.lines(["Hello"]));
      await stream.readNext(); // first call
      const lines = await stream.readNext(); // second call
      assert.strictEqual(lines.length, 0);
    });

    it("returns queued lines on subsequent calls", async () => {
      const stream = new FakeTerminalStream(FakeTerminalStream.lines(["Initial"]));
      stream.queueLines(FakeTerminalStream.lines(["Queued 1"]));
      stream.queueLines(FakeTerminalStream.lines(["Queued 2"]));

      await stream.readNext(); // returns initial
      const second = await stream.readNext(); // returns Queued 1
      const third = await stream.readNext(); // returns Queued 2

      assert.strictEqual(second[0].raw, "Queued 1");
      assert.strictEqual(third[0].raw, "Queued 2");
    });

    it("respects max option", async () => {
      const stream = new FakeTerminalStream(
        FakeTerminalStream.lines(["Line 1", "Line 2", "Line 3"]),
      );
      const lines = await stream.readNext({ max: 2 });
      assert.strictEqual(lines.length, 2);
    });
  });

  describe("waitForMatch", () => {
    it("finds match in initial lines", async () => {
      const stream = new FakeTerminalStream(FakeTerminalStream.lines(["No match", "Error: found"]));
      const result = await stream.waitForMatch({ pattern: "Error" });
      assert.strictEqual(result.matched, true);
      assert.strictEqual(result.lineIndex, 1);
    });

    it("finds match in pending lines", async () => {
      const stream = new FakeTerminalStream(FakeTerminalStream.lines(["Initial"]));
      stream.queueLines(FakeTerminalStream.lines(["Found it!"]));

      const result = await stream.waitForMatch({ pattern: "Found" });
      assert.strictEqual(result.matched, true);
    });

    it("returns no match when pattern not found", async () => {
      const stream = new FakeTerminalStream(FakeTerminalStream.lines(["Hello", "World"]));
      const result = await stream.waitForMatch({ pattern: "Missing" });
      assert.strictEqual(result.matched, false);
    });

    it("matches with regex pattern", async () => {
      const stream = new FakeTerminalStream(FakeTerminalStream.lines(["Error: 404 not found"]));
      const result = await stream.waitForMatch({ pattern: /Error:\s+\d+/ });
      assert.strictEqual(result.matched, true);
    });
  });

  describe("addLines", () => {
    it("adds lines to buffer", async () => {
      const stream = new FakeTerminalStream(FakeTerminalStream.lines(["Initial"]));
      stream.addLines(FakeTerminalStream.lines(["Added"]));

      // Initial lines include Added now
      const lines = await stream.readNext();
      assert.strictEqual(lines.length, 2);
      assert.strictEqual(lines[1].raw, "Added");
    });
  });
});

describe("JsonlTerminalStream", () => {
  it("constructs with log path finder and format", () => {
    const stream = new JsonlTerminalStream(() => null, "claude");
    assert.strictEqual(stream.format, "claude");
    assert.strictEqual(stream.offset, 0);
  });

  it("returns empty array when no log path", async () => {
    const stream = new JsonlTerminalStream(() => null, "claude");
    const lines = await stream.readNext();
    assert.deepStrictEqual(lines, []);
  });
});

describe("ScreenTerminalStream", () => {
  it("constructs with session name", () => {
    const stream = new ScreenTerminalStream("test-session", 100);
    assert.strictEqual(stream.session, "test-session");
    assert.strictEqual(stream.scrollback, 100);
  });

  it("tracks last screen", () => {
    const stream = new ScreenTerminalStream("test-session");
    assert.strictEqual(stream.getLastScreen(), "");
  });
});

describe("StyledScreenTerminalStream", () => {
  it("constructs with session name", () => {
    const stream = new StyledScreenTerminalStream("test-session", 100);
    assert.strictEqual(stream.session, "test-session");
    assert.strictEqual(stream.scrollback, 100);
  });

  it("tracks last screen", () => {
    const stream = new StyledScreenTerminalStream("test-session");
    assert.strictEqual(stream.getLastScreen(), "");
  });
});

describe("Agent.createStream", () => {
  it("ClaudeAgent creates JsonlTerminalStream", () => {
    const stream = ClaudeAgent.createStream("claude-partner-12345678-1234-1234-1234-123456789abc");
    assert.ok(stream instanceof JsonlTerminalStream);
    assert.strictEqual(stream.format, "claude");
  });

  it("CodexAgent creates JsonlTerminalStream", () => {
    const stream = CodexAgent.createStream("codex-partner-12345678-1234-1234-1234-123456789abc");
    assert.ok(stream instanceof JsonlTerminalStream);
    assert.strictEqual(stream.format, "codex");
  });

  it("createStyledStream returns StyledScreenTerminalStream", () => {
    const stream = ClaudeAgent.createStyledStream("claude-partner-123", 50);
    assert.ok(stream instanceof StyledScreenTerminalStream);
    assert.strictEqual(stream.session, "claude-partner-123");
    assert.strictEqual(stream.scrollback, 50);
  });
});

// =============================================================================
// ANSI Parsing - parseAnsiLine, parseStyledScreenLines
// =============================================================================

describe("parseAnsiLine", () => {
  describe("plain text (no escapes)", () => {
    it("returns single unstyled span for plain text", () => {
      const spans = parseAnsiLine("Hello world");
      assert.strictEqual(spans.length, 1);
      assert.strictEqual(spans[0].text, "Hello world");
      assert.strictEqual(spans[0].style, undefined);
    });

    it("handles empty string", () => {
      const spans = parseAnsiLine("");
      assert.strictEqual(spans.length, 1);
      assert.strictEqual(spans[0].text, "");
    });

    it("handles null/undefined", () => {
      assert.strictEqual(parseAnsiLine(null)[0].text, "");
      assert.strictEqual(parseAnsiLine(undefined)[0].text, "");
    });
  });

  describe("foreground colors", () => {
    it("parses red text", () => {
      const spans = parseAnsiLine("\x1b[31mError\x1b[0m");
      assert.strictEqual(spans.length, 1);
      assert.strictEqual(spans[0].text, "Error");
      assert.strictEqual(spans[0].style.fg, "red");
    });

    it("parses green text", () => {
      const spans = parseAnsiLine("\x1b[32mSuccess\x1b[0m");
      assert.strictEqual(spans[0].text, "Success");
      assert.strictEqual(spans[0].style.fg, "green");
    });

    it("parses bright colors", () => {
      const spans = parseAnsiLine("\x1b[91mBright Red\x1b[0m");
      assert.strictEqual(spans[0].text, "Bright Red");
      assert.strictEqual(spans[0].style.fg, "bright-red");
    });
  });

  describe("background colors", () => {
    it("parses background color", () => {
      const spans = parseAnsiLine("\x1b[44mBlue BG\x1b[0m");
      assert.strictEqual(spans[0].text, "Blue BG");
      assert.strictEqual(spans[0].style.bg, "blue");
    });
  });

  describe("text attributes", () => {
    it("parses bold text", () => {
      const spans = parseAnsiLine("\x1b[1mBold\x1b[0m");
      assert.strictEqual(spans[0].text, "Bold");
      assert.strictEqual(spans[0].style.bold, true);
    });

    it("parses dim text", () => {
      const spans = parseAnsiLine("\x1b[2mDim\x1b[0m");
      assert.strictEqual(spans[0].text, "Dim");
      assert.strictEqual(spans[0].style.dim, true);
    });

    it("parses italic text", () => {
      const spans = parseAnsiLine("\x1b[3mItalic\x1b[0m");
      assert.strictEqual(spans[0].text, "Italic");
      assert.strictEqual(spans[0].style.italic, true);
    });

    it("parses underlined text", () => {
      const spans = parseAnsiLine("\x1b[4mUnderline\x1b[0m");
      assert.strictEqual(spans[0].text, "Underline");
      assert.strictEqual(spans[0].style.underline, true);
    });
  });

  describe("combined styles", () => {
    it("parses bold red text", () => {
      const spans = parseAnsiLine("\x1b[1;31mBold Red\x1b[0m");
      assert.strictEqual(spans[0].text, "Bold Red");
      assert.strictEqual(spans[0].style.bold, true);
      assert.strictEqual(spans[0].style.fg, "red");
    });

    it("parses multiple spans with different colors", () => {
      const spans = parseAnsiLine("Normal \x1b[31mRed\x1b[0m \x1b[32mGreen\x1b[0m");
      assert.strictEqual(spans.length, 4);
      assert.strictEqual(spans[0].text, "Normal ");
      assert.strictEqual(spans[0].style, undefined);
      assert.strictEqual(spans[1].text, "Red");
      assert.strictEqual(spans[1].style.fg, "red");
      assert.strictEqual(spans[2].text, " ");
      assert.strictEqual(spans[3].text, "Green");
      assert.strictEqual(spans[3].style.fg, "green");
    });
  });

  describe("reset and default codes", () => {
    it("resets style with code 0", () => {
      const spans = parseAnsiLine("\x1b[31mRed\x1b[0mNormal");
      assert.strictEqual(spans[1].text, "Normal");
      assert.strictEqual(spans[1].style, undefined);
    });

    it("resets style with empty params (\\x1b[m)", () => {
      // Common shorthand: \x1b[m is equivalent to \x1b[0m
      const spans = parseAnsiLine("\x1b[31mRed\x1b[mNormal");
      assert.strictEqual(spans[0].text, "Red");
      assert.strictEqual(spans[0].style.fg, "red");
      assert.strictEqual(spans[1].text, "Normal");
      assert.strictEqual(spans[1].style, undefined);
    });

    it("resets foreground with code 39", () => {
      const spans = parseAnsiLine("\x1b[31mRed\x1b[39mDefault");
      assert.strictEqual(spans[0].style.fg, "red");
      assert.strictEqual(spans[1].style?.fg, undefined);
    });

    it("resets bold/dim with code 22", () => {
      const spans = parseAnsiLine("\x1b[1mBold\x1b[22mNormal");
      assert.strictEqual(spans[0].style.bold, true);
      // After 22, bold should be removed
      const span1Style = spans[1].style || {};
      assert.strictEqual(span1Style.bold, undefined);
    });
  });
});

describe("parseStyledScreenLines", () => {
  it("parses multiple lines with colors", () => {
    const screen = "\x1b[32mLine 1\x1b[0m\n\x1b[31mLine 2\x1b[0m";
    const lines = parseStyledScreenLines(screen);
    assert.strictEqual(lines.length, 2);
    assert.strictEqual(lines[0].raw, "Line 1");
    assert.strictEqual(lines[0].spans[0].style.fg, "green");
    assert.strictEqual(lines[1].raw, "Line 2");
    assert.strictEqual(lines[1].spans[0].style.fg, "red");
  });

  it("joins spans to create raw text", () => {
    const screen = "Normal \x1b[31mRed\x1b[0m Text";
    const lines = parseStyledScreenLines(screen);
    assert.strictEqual(lines[0].raw, "Normal Red Text");
  });

  it("returns empty array for empty input", () => {
    assert.deepStrictEqual(parseStyledScreenLines(""), []);
    assert.deepStrictEqual(parseStyledScreenLines(null), []);
  });
});
