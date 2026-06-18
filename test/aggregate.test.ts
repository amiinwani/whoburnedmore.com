import assert from "node:assert/strict";
import { test } from "node:test";
import { applyRecord, emptyReport } from "../src/scan.js";

const freshReport = emptyReport;

function assistant(usage: Record<string, number>, extra: Record<string, unknown> = {}) {
  return {
    type: "assistant",
    timestamp: "2026-06-10T12:00:00.000Z",
    cwd: "/Users/me/code/my-app",
    message: { model: "claude-sonnet-4-5", usage },
    ...extra,
  };
}

test("applyRecord sums every token class into the totals", () => {
  const r = freshReport();
  applyRecord(
    r,
    assistant({
      input_tokens: 100,
      output_tokens: 50,
      cache_creation_input_tokens: 30,
      cache_read_input_tokens: 1000,
    }),
    null,
  );
  assert.equal(r.totals.input, 100);
  assert.equal(r.totals.output, 50);
  assert.equal(r.totals.cacheWrite, 30);
  assert.equal(r.totals.cacheRead, 1000);
  assert.equal(r.totals.tokens, 1180);
  assert.equal(r.totals.messages, 1);
  assert.ok(r.totals.costUSD > 0);
});

test("applyRecord groups by model, project label, and day", () => {
  const r = freshReport();
  applyRecord(r, assistant({ input_tokens: 10, output_tokens: 10 }), null);
  applyRecord(r, assistant({ input_tokens: 10, output_tokens: 10 }), null);
  assert.equal(r.byModel.get("claude-sonnet-4-5")?.messages, 2);
  assert.equal(r.byProject.get("my-app")?.tokens, 40);
  assert.equal(r.byDay.get("2026-06-10")?.tokens, 40);
  assert.equal(r.firstDate, "2026-06-10");
  assert.equal(r.lastDate, "2026-06-10");
});

test("applyRecord ignores non-assistant records and zero-token turns", () => {
  const r = freshReport();
  applyRecord(r, { type: "user", message: {} }, null);
  applyRecord(r, assistant({ input_tokens: 0, output_tokens: 0 }), null);
  assert.equal(r.totals.messages, 0);
  assert.equal(r.totals.tokens, 0);
});

test("applyRecord respects the --since cutoff", () => {
  const r = freshReport();
  const cutoff = Date.parse("2026-06-01T00:00:00.000Z");
  // older than cutoff -> skipped
  applyRecord(
    r,
    assistant({ input_tokens: 10, output_tokens: 10 }, { timestamp: "2026-05-01T00:00:00.000Z" }),
    cutoff,
  );
  // newer than cutoff -> counted
  applyRecord(
    r,
    assistant({ input_tokens: 10, output_tokens: 10 }, { timestamp: "2026-06-15T00:00:00.000Z" }),
    cutoff,
  );
  assert.equal(r.totals.messages, 1);
});

test("applyRecord labels missing cwd as 'unknown' without crashing", () => {
  const r = freshReport();
  applyRecord(r, assistant({ input_tokens: 5, output_tokens: 5 }, { cwd: undefined }), null);
  assert.equal(r.byProject.get("unknown")?.messages, 1);
});

test("applyRecord tags every Claude turn with the claude-code agent", () => {
  const r = freshReport();
  applyRecord(r, assistant({ input_tokens: 10, output_tokens: 10 }), null);
  assert.equal(r.byAgent.get("claude-code")?.tokens, 20);
});

// --- §4 transcript attribution -------------------------------------------------

test("applyRecord counts tool uses and splits the turn's tokens across them", () => {
  const r = freshReport();
  applyRecord(
    r,
    assistant(
      { input_tokens: 100, output_tokens: 100 }, // 200 tokens, 2 tools -> 100 each
      {
        message: {
          model: "claude-sonnet-4-5",
          usage: { input_tokens: 100, output_tokens: 100 },
          content: [
            { type: "tool_use", id: "a", name: "Bash" },
            { type: "tool_use", id: "b", name: "Read" },
          ],
        },
      },
    ),
    null,
  );
  assert.equal(r.byTool.get("Bash")?.count, 1);
  assert.equal(r.byTool.get("Read")?.count, 1);
  assert.equal(r.byTool.get("Bash")?.tokens, 100);
  assert.equal(r.byTool.get("Read")?.tokens, 100);
});

test("applyRecord matches is_error tool_result back to its tool_use within a file", () => {
  const r = freshReport();
  const state = { toolNameById: new Map<string, string>() };
  // assistant calls Bash twice
  applyRecord(
    r,
    {
      type: "assistant",
      timestamp: "2026-06-10T12:00:00.000Z",
      cwd: "/x/proj",
      message: {
        model: "claude-sonnet-4-5",
        usage: { input_tokens: 10, output_tokens: 10 },
        content: [
          { type: "tool_use", id: "t1", name: "Bash" },
          { type: "tool_use", id: "t2", name: "Bash" },
        ],
      },
    },
    null,
    state,
  );
  // a user turn carries one error result and one success result
  applyRecord(
    r,
    {
      type: "user",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "t1", is_error: true },
          { type: "tool_result", tool_use_id: "t2" },
        ],
      },
    },
    null,
    state,
  );
  assert.equal(r.byTool.get("Bash")?.count, 2);
  assert.equal(r.byTool.get("Bash")?.errors, 1);
});

test("applyRecord counts subagent (sidechain) tokens separately", () => {
  const r = freshReport();
  applyRecord(r, assistant({ input_tokens: 60, output_tokens: 40 }), null); // 100 main
  applyRecord(
    r,
    assistant({ input_tokens: 30, output_tokens: 20 }, { isSidechain: true }), // 50 sidechain
    null,
  );
  assert.equal(r.totals.tokens, 150);
  assert.equal(r.subagentTokens, 50);
  assert.equal(r.subagentMessages, 1);
});

test("human-message counting includes real typed turns and excludes the rest", () => {
  const r = freshReport();
  const user = (extra: Record<string, unknown>) =>
    applyRecord(r, { type: "user", message: { role: "user" }, ...extra }, null);

  // real typed text -> counts
  user({ message: { role: "user", content: "please fix the failing test" } });
  // tool-result-only turn -> excluded
  user({ message: { role: "user", content: [{ type: "tool_result", tool_use_id: "z" }] } });
  // injected system reminder -> excluded
  user({ message: { role: "user", content: "<system-reminder>be brief</system-reminder>" } });
  // slash-command expansion -> excluded
  user({ message: { role: "user", content: "<command-name>/build</command-name>" } });
  // Caveat preamble -> excluded
  user({ message: { role: "user", content: "Caveat: the messages below were generated" } });
  // sidechain user turn -> excluded
  user({ isSidechain: true, message: { role: "user", content: "subagent text" } });
  // meta record -> excluded
  user({ isMeta: true, message: { role: "user", content: "meta text" } });
  // another real one (array with a text block)
  user({ message: { role: "user", content: [{ type: "text", text: "and add a test" }] } });

  assert.equal(r.humanMessages, 2);
});

test("applyRecord tallies a skill when the field is present, and skips it otherwise", () => {
  const withSkill = freshReport();
  applyRecord(
    withSkill,
    assistant({ input_tokens: 50, output_tokens: 50 }, { skill: "code-review" }),
    null,
  );
  assert.equal(withSkill.bySkill.get("code-review")?.count, 1);
  assert.equal(withSkill.bySkill.get("code-review")?.tokens, 100);

  const without = freshReport();
  applyRecord(without, assistant({ input_tokens: 50, output_tokens: 50 }), null);
  assert.equal(without.bySkill.size, 0);
});
