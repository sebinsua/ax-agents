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

// Claude-like config for testing
const claudeConfig = {
  promptSymbol: "❯",
  spinners: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  rateLimitPattern: /rate.?limit/i,
  thinkingPatterns: ["Thinking"],
  confirmPatterns: [
    "Do you want to proceed",
    (lines) => /\d+\.\s*(Yes|No|Allow|Deny)/i.test(lines),
  ],
  updatePromptPatterns: null,
};

// Codex-like config for testing
const codexConfig = {
  promptSymbol: "›",
  spinners: ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
  rateLimitPattern: /■.*(?:usage limit|rate limit|try again at)/i,
  thinkingPatterns: ["Thinking…", "Thinking..."],
  confirmPatterns: [
    (lines) => lines.includes("[y]") && lines.includes("[n]"),
    "Run command?",
  ],
  updatePromptPatterns: {
    screen: ["Update available"],
    lastLines: ["Skip"],
  },
};

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
      assert.strictEqual(detectState(screen, claudeConfig), State.STARTING);
    });
  });

  describe("THINKING state", () => {
    it("detects thinking from spinner character", () => {
      const screen = `Working on your request

⠋ Processing files...

Some status`;
      assert.strictEqual(detectState(screen, claudeConfig), State.THINKING);
    });

    it("detects thinking from text pattern (Claude)", () => {
      const screen = `Some context

Thinking

❯ `;
      // Note: Thinking in last lines takes precedence, but spinner check comes first
      // This tests the thinkingPatterns check
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

  describe("priority order", () => {
    it("rate limit beats everything", () => {
      const screen = `Rate limit hit
⠋ Still spinning
Do you want to proceed?
❯ `;
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
  });
});
