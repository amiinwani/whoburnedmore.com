import assert from "node:assert/strict";
import { test } from "node:test";
import { applyCodexRecord, emptyReport } from "../src/scan.js";

function freshState() {
  return { cwd: undefined as string | undefined, model: "unknown", pending: [] as string[] };
}

test("session_meta sets the cwd and model for the file", () => {
  const r = emptyReport();
  const state = freshState();
  applyCodexRecord(
    r,
    { type: "session_meta", payload: { cwd: "/Users/me/code/codex-app", model: "gpt-5" } },
    null,
    state,
  );
  assert.equal(state.cwd, "/Users/me/code/codex-app");
  assert.equal(state.model, "gpt-5");
});

test("a token_count closes a turn and maps Codex usage onto our buckets", () => {
  const r = emptyReport();
  const state = freshState();
  // pick up cwd + model first
  applyCodexRecord(
    r,
    { type: "turn_context", payload: { cwd: "/Users/me/code/codex-app", model: "gpt-5" } },
    null,
    state,
  );
  // two tool calls in this turn
  applyCodexRecord(r, { type: "function_call", payload: { name: "apply_patch" } }, null, state);
  applyCodexRecord(r, { type: "local_shell_call", payload: {} }, null, state);
  // token count closes the turn
  applyCodexRecord(
    r,
    {
      type: "token_count",
      timestamp: "2026-06-12T10:00:00.000Z",
      payload: {
        info: {
          last_token_usage: {
            input_tokens: 1000,
            cached_input_tokens: 400,
            output_tokens: 200,
            reasoning_output_tokens: 50,
            total_tokens: 1650,
          },
        },
      },
    },
    null,
    state,
  );

  const total = r.totals;
  // plain input = 1000 - 400 cached = 600; output = 200 + 50 reasoning = 250; cacheRead = 400
  assert.equal(total.input, 600);
  assert.equal(total.output, 250);
  assert.equal(total.cacheRead, 400);
  assert.equal(total.tokens, 600 + 250 + 400);

  // tagged as the codex agent + bucketed under the cwd basename
  assert.equal(r.byAgent.get("codex")?.tokens, 1250);
  assert.equal(r.byProject.get("codex-app")?.tokens, 1250);
  assert.equal(r.byModel.get("gpt-5")?.tokens, 1250);

  // turn tokens split across the two pending tool calls; pending cleared after
  assert.equal(r.byTool.get("apply_patch")?.count, 1);
  assert.equal(r.byTool.get("shell")?.count, 1);
  assert.equal(r.byTool.get("apply_patch")?.tokens, 625);
  assert.equal(r.byTool.get("shell")?.tokens, 625);
  assert.equal(state.pending.length, 0);

  // Codex has no subagents
  assert.equal(r.subagentTokens, 0);
});

test("Codex --since cutoff drops an old turn and clears pending", () => {
  const r = emptyReport();
  const state = freshState();
  const cutoff = Date.parse("2026-06-01T00:00:00.000Z");
  applyCodexRecord(r, { type: "session_meta", payload: { cwd: "/x/p", model: "gpt-5" } }, cutoff, state);
  applyCodexRecord(r, { type: "function_call", payload: { name: "tool" } }, cutoff, state);
  applyCodexRecord(
    r,
    {
      type: "token_count",
      timestamp: "2026-05-01T00:00:00.000Z",
      payload: { info: { last_token_usage: { input_tokens: 100, output_tokens: 100 } } },
    },
    cutoff,
    state,
  );
  assert.equal(r.totals.tokens, 0);
  assert.equal(state.pending.length, 0);
});

test("a flat (un-wrapped) token_count record also folds", () => {
  const r = emptyReport();
  const state = freshState();
  state.cwd = "/x/flat";
  state.model = "gpt-5";
  applyCodexRecord(
    r,
    {
      type: "token_count",
      timestamp: "2026-06-12T10:00:00.000Z",
      info: { last_token_usage: { input_tokens: 10, output_tokens: 10 } },
    } as never,
    null,
    state,
  );
  assert.equal(r.totals.tokens, 20);
  assert.equal(r.byAgent.get("codex")?.tokens, 20);
});
