import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import type {
  AgentStat,
  ProjectStat,
  SkillStat,
  ToolStat,
} from "./shared.js";
import { estimateCostUSD } from "./pricing.js";

// ccusage gives tokens by tool/model, but not which tools/skills/MCP servers you
// actually invoke, which projects you spend in, how much runs inside subagents,
// or how reliable your tools are. That all lives in Claude Code's transcripts:
// each record may have an `attributionSkill`, assistant messages carry `tool_use`
// blocks (name = tool) plus a `usage` block (tokens) and a `cwd` (project) and an
// `isSidechain` flag (subagent), and tool failures show up as `tool_result`
// blocks with `is_error`. We count names + tokens — never arguments or content.
// Best-effort and bounded so a huge ~/.claude never makes the CLI hang.

const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");
const CODEX_SESSIONS = join(homedir(), ".codex", "sessions");
const MAX_FILES = 5000;
const MAX_FILE_BYTES = 64 * 1024 * 1024;
// Bounded so a huge ~/.claude never makes the CLI drag. The scan yields to the
// event loop between files (see collectAttribution) so the loading bar keeps
// animating even while we're chewing through transcripts.
const TIME_BUDGET_MS = 12_000;
const MAX_STATS = 300;
const MAX_PROJECTS = 500;

/**
 * Count tool_use names and the attributionSkill on one parsed transcript record.
 * Pure + tested; mutates the provided maps. Unknown shapes are ignored. Kept for
 * back-compat — the richer pass below is what collectAttribution() now uses.
 */
export function countRecord(
  rec: unknown,
  tools: Map<string, number>,
  skills: Map<string, number>,
): void {
  if (!rec || typeof rec !== "object") return;
  const r = rec as {
    message?: { content?: unknown };
    attributionSkill?: unknown;
  };
  const content = r.message?.content;
  if (Array.isArray(content)) {
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_use" &&
        typeof (block as { name?: unknown }).name === "string"
      ) {
        const name = (block as { name: string }).name.slice(0, 128);
        if (name) tools.set(name, (tools.get(name) ?? 0) + 1);
      }
    }
  }
  if (typeof r.attributionSkill === "string" && r.attributionSkill) {
    const s = r.attributionSkill.slice(0, 128);
    skills.set(s, (skills.get(s) ?? 0) + 1);
  }
}

/** Mutable accumulator for one full pass over the transcripts. */
export interface Accumulator {
  tools: Map<string, { count: number; errors: number; tokens: number }>;
  skills: Map<string, { count: number; tokens: number }>;
  projects: Map<string, { tokens: number; costUSD: number }>;
  agent: {
    messageCount: number;
    subagentMessages: number;
    subagentTokens: number;
    totalTokens: number;
    /** Messages the human actually sent (their prompts). */
    userMessageCount: number;
  };
  /** sessionId -> latest AI title. */
  titles: Map<string, string>;
  /** sessionId -> assistant message count. */
  sessionMessages: Map<string, number>;
}

/** Per-file scratch state (tool_use id -> tool name, for error matching). */
export interface FileContext {
  toolNames: Map<string, string>;
}

export function createAccumulator(): Accumulator {
  return {
    tools: new Map(),
    skills: new Map(),
    projects: new Map(),
    agent: {
      messageCount: 0,
      subagentMessages: 0,
      subagentTokens: 0,
      totalTokens: 0,
      userMessageCount: 0,
    },
    titles: new Map(),
    sessionMessages: new Map(),
  };
}

export function createFileContext(): FileContext {
  return { toolNames: new Map() };
}

function recordTokens(usage: unknown): number {
  if (!usage || typeof usage !== "object") return 0;
  const u = usage as Record<string, unknown>;
  const n = (v: unknown) => {
    const x = Math.round(Number(v));
    return Number.isFinite(x) && x > 0 ? x : 0;
  };
  return (
    n(u.input_tokens) +
    n(u.output_tokens) +
    n(u.cache_creation_input_tokens) +
    n(u.cache_read_input_tokens)
  );
}

/**
 * True when a user record carries an actual human prompt: a non-empty string,
 * or a `text` block with non-empty text — and not an injected system turn
 * (system-reminder / slash-command expansion). tool_result-only turns return
 * false (no text), so they don't count as messages the person sent.
 */
function hasHumanText(content: unknown): boolean {
  const isHuman = (t: string): boolean => {
    const s = t.trim();
    return (
      s.length > 0 &&
      !s.startsWith("<system-reminder") &&
      !s.startsWith("<command-") &&
      !s.startsWith("Caveat:")
    );
  };
  if (typeof content === "string") return isHuman(content);
  if (!Array.isArray(content)) return false;
  return content.some(
    (b) =>
      b !== null &&
      typeof b === "object" &&
      (b as { type?: unknown }).type === "text" &&
      typeof (b as { text?: unknown }).text === "string" &&
      isHuman((b as { text: string }).text),
  );
}

/**
 * Fold one parsed transcript record into the accumulator. Handles: tool_use
 * names + per-tool error counts (matched by tool_use_id within the file),
 * per-project tokens/cost (by `cwd` basename), subagent vs total tokens/messages,
 * per-session message counts, AI titles, and attributionSkill. Pure aside from
 * the maps it mutates; unknown shapes are ignored.
 */
export function processRecord(
  rec: unknown,
  acc: Accumulator,
  ctx: FileContext,
): void {
  if (!rec || typeof rec !== "object") return;
  const r = rec as {
    type?: unknown;
    cwd?: unknown;
    isSidechain?: unknown;
    isMeta?: unknown;
    sessionId?: unknown;
    aiTitle?: unknown;
    attributionSkill?: unknown;
    message?: { role?: unknown; content?: unknown; model?: unknown; usage?: unknown };
  };

  const recTokens = recordTokens(r.message?.usage);

  // Count messages the human actually sent: a non-sidechain, non-meta user turn
  // that carries real typed text (string content or a text block) — NOT a
  // tool_result turn (those are role:user too) and NOT a system-reminder/injected
  // turn. This is the denominator for "avg cost per message".
  if (
    (r.type === "user" || r.message?.role === "user") &&
    r.isSidechain !== true &&
    r.isMeta !== true &&
    hasHumanText(r.message?.content)
  ) {
    acc.agent.userMessageCount += 1;
  }

  if (typeof r.attributionSkill === "string" && r.attributionSkill) {
    const s = r.attributionSkill.slice(0, 128);
    const sk = acc.skills.get(s) ?? { count: 0, tokens: 0 };
    sk.count += 1;
    sk.tokens += recTokens;
    acc.skills.set(s, sk);
  }

  // AI-generated session title (one record type per session; last one wins).
  if (
    r.type === "ai-title" &&
    typeof r.aiTitle === "string" &&
    r.aiTitle &&
    typeof r.sessionId === "string" &&
    r.sessionId
  ) {
    acc.titles.set(r.sessionId, r.aiTitle.slice(0, 200));
  }

  const content = r.message?.content;
  if (!Array.isArray(content)) return;

  const isAssistant = r.type === "assistant" || r.message?.role === "assistant";
  const isUser = r.type === "user" || r.message?.role === "user";

  if (isAssistant) {
    // tool_use names + per-tool tokens (the turn's tokens split evenly across
    // its tool calls), plus id->name for error matching.
    const toolUses: Array<{ name: string; id?: string }> = [];
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_use" &&
        typeof (block as { name?: unknown }).name === "string"
      ) {
        const name = (block as { name: string }).name.slice(0, 128);
        if (!name) continue;
        const id = (block as { id?: unknown }).id;
        toolUses.push({ name, id: typeof id === "string" ? id : undefined });
      }
    }
    const perToolTokens =
      toolUses.length > 0 ? Math.floor(recTokens / toolUses.length) : 0;
    for (const tu of toolUses) {
      const t = acc.tools.get(tu.name) ?? { count: 0, errors: 0, tokens: 0 };
      t.count += 1;
      t.tokens += perToolTokens;
      acc.tools.set(tu.name, t);
      if (tu.id) ctx.toolNames.set(tu.id, tu.name);
    }

    // Per-message tokens → project, subagent, message-count rollups.
    const tokens = recTokens;
    acc.agent.messageCount += 1;
    acc.agent.totalTokens += tokens;
    const sidechain = r.isSidechain === true;
    if (sidechain) {
      acc.agent.subagentMessages += 1;
      acc.agent.subagentTokens += tokens;
    }
    if (typeof r.sessionId === "string" && r.sessionId) {
      acc.sessionMessages.set(
        r.sessionId,
        (acc.sessionMessages.get(r.sessionId) ?? 0) + 1,
      );
    }
    if (typeof r.cwd === "string" && r.cwd && tokens > 0) {
      const name = basename(r.cwd).slice(0, 128) || "unknown";
      const model = typeof r.message?.model === "string" ? r.message.model : "unknown";
      const u = r.message?.usage as Record<string, unknown> | undefined;
      const num = (v: unknown) => {
        const x = Math.round(Number(v));
        return Number.isFinite(x) && x > 0 ? x : 0;
      };
      const cost = estimateCostUSD(model, {
        inputTokens: num(u?.input_tokens),
        outputTokens: num(u?.output_tokens),
        cacheCreationTokens: num(u?.cache_creation_input_tokens),
        cacheReadTokens: num(u?.cache_read_input_tokens),
      });
      const p = acc.projects.get(name) ?? { tokens: 0, costUSD: 0 };
      p.tokens += tokens;
      p.costUSD += cost;
      acc.projects.set(name, p);
    }
  } else if (isUser) {
    // tool_result errors → bump the matching tool's error count.
    for (const block of content) {
      if (
        block &&
        typeof block === "object" &&
        (block as { type?: unknown }).type === "tool_result" &&
        (block as { is_error?: unknown }).is_error === true
      ) {
        const id = (block as { tool_use_id?: unknown }).tool_use_id;
        const name = typeof id === "string" ? ctx.toolNames.get(id) : undefined;
        if (name) {
          const t = acc.tools.get(name) ?? { count: 0, errors: 0, tokens: 0 };
          t.errors += 1;
          acc.tools.set(name, t);
        }
      }
    }
  }
}

/** Convert the skill map into a sorted, capped {name, count, tokens}[]. */
function toSkillStats(map: Map<string, { count: number; tokens: number }>): SkillStat[] {
  return [...map.entries()]
    .map(([name, v]) => ({ name, count: v.count, tokens: v.tokens }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.tokens - a.tokens || b.count - a.count)
    .slice(0, MAX_STATS)
    .map((s) => (s.tokens > 0 ? s : { name: s.name, count: s.count }));
}

function toToolStats(
  map: Map<string, { count: number; errors: number; tokens: number }>,
): ToolStat[] {
  return [...map.entries()]
    .map(([name, v]) => ({ name, count: v.count, errors: v.errors, tokens: v.tokens }))
    .filter((s) => s.count > 0)
    .sort((a, b) => b.tokens - a.tokens || b.count - a.count)
    .slice(0, MAX_STATS)
    // Only attach errors/tokens when nonzero, so legacy-shaped consumers see
    // the same minimal payload.
    .map((s) => {
      const base: ToolStat = { name: s.name, count: s.count };
      if (s.errors > 0) base.errors = s.errors;
      if (s.tokens > 0) base.tokens = s.tokens;
      return base;
    });
}

function toProjectStats(map: Map<string, { tokens: number; costUSD: number }>): ProjectStat[] {
  return [...map.entries()]
    .map(([name, v]) => ({
      name,
      tokens: v.tokens,
      costUSD: Number(v.costUSD.toFixed(6)),
    }))
    .filter((p) => p.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens)
    .slice(0, MAX_PROJECTS);
}

export interface AttributionResult {
  tools: ToolStat[];
  skills: SkillStat[];
  projects: ProjectStat[];
  agent: AgentStat;
  /** sessionId -> AI title (joined onto session rollups by collect). */
  titles: Map<string, string>;
  /** sessionId -> assistant message count. */
  sessionMessages: Map<string, number>;
  /**
   * False if transcript scanning hit its time budget (snapshot may be partial,
   * so the server applies its no-shrink guard). True for a full pass — the server
   * then refreshes the breakdowns unconditionally so they never go stale.
   */
  complete: boolean;
}

export function accumulatorToResult(acc: Accumulator): AttributionResult {
  return {
    tools: toToolStats(acc.tools),
    skills: toSkillStats(acc.skills),
    projects: toProjectStats(acc.projects),
    agent: { ...acc.agent },
    titles: acc.titles,
    sessionMessages: acc.sessionMessages,
    complete: true,
  };
}

function numTok(v: unknown): number {
  const x = Math.round(Number(v));
  return Number.isFinite(x) && x > 0 ? x : 0;
}

/** Per-file scratch state for a Codex rollout transcript. */
export interface CodexContext {
  cwd: string;
  model: string;
  /** function_calls seen since the last token_count, for the per-tool token split. */
  pending: Array<{ name: string; id?: string }>;
}
export function createCodexContext(): CodexContext {
  return { cwd: "", model: "unknown", pending: [] };
}

/**
 * Fold one Codex rollout record into the accumulator. Codex writes a JSONL
 * "rollout" per session: `session_meta`/`turn_context` carry the `cwd` + model,
 * `response_item` payloads of type `function_call` (or `custom_tool_call` /
 * `local_shell_call`) are tool calls (MCP tools keep their server-prefixed name),
 * and `event_msg` payloads of type `token_count` carry the turn's
 * `last_token_usage`. We attribute that turn's tokens to the project (cwd) and
 * split them across the tools called in the turn. Codex has no subagent concept,
 * so the subagent counters stay zero. Names + counts only — never content.
 */
export function processCodexRecord(
  rec: unknown,
  acc: Accumulator,
  ctx: CodexContext,
): void {
  if (!rec || typeof rec !== "object") return;
  const r = rec as { type?: unknown; payload?: unknown };
  if (!r.payload || typeof r.payload !== "object") return;
  const pl = r.payload as Record<string, unknown>;
  const ptype = pl.type;

  if (r.type === "session_meta" || r.type === "turn_context") {
    if (typeof pl.cwd === "string" && pl.cwd) ctx.cwd = pl.cwd;
    if (typeof pl.model === "string" && pl.model) ctx.model = pl.model;
    return;
  }

  if (
    ptype === "function_call" ||
    ptype === "custom_tool_call" ||
    ptype === "local_shell_call"
  ) {
    const raw =
      typeof pl.name === "string"
        ? pl.name
        : ptype === "local_shell_call"
          ? "local_shell"
          : "";
    const name = raw.slice(0, 128);
    if (!name) return;
    const id = typeof pl.call_id === "string" ? pl.call_id : undefined;
    ctx.pending.push({ name, id });
    const t = acc.tools.get(name) ?? { count: 0, errors: 0, tokens: 0 };
    t.count += 1;
    acc.tools.set(name, t);
    return;
  }

  if (ptype === "token_count") {
    const info = pl.info as
      | { last_token_usage?: Record<string, unknown> }
      | null
      | undefined;
    const last = info?.last_token_usage;
    if (!last) return;
    const inputTokens = numTok(last.input_tokens);
    const cacheReadTokens = numTok(last.cached_input_tokens);
    const outputTokens =
      numTok(last.output_tokens) + numTok(last.reasoning_output_tokens);
    const tokens =
      numTok(last.total_tokens) || inputTokens + cacheReadTokens + outputTokens;
    if (tokens <= 0) {
      ctx.pending = [];
      return;
    }

    acc.agent.messageCount += 1;
    acc.agent.totalTokens += tokens;

    if (ctx.cwd) {
      const name = basename(ctx.cwd).slice(0, 128) || "unknown";
      const cost = estimateCostUSD(ctx.model, {
        inputTokens,
        outputTokens,
        cacheCreationTokens: 0,
        cacheReadTokens,
      });
      const proj = acc.projects.get(name) ?? { tokens: 0, costUSD: 0 };
      proj.tokens += tokens;
      proj.costUSD += cost;
      acc.projects.set(name, proj);
    }

    const per =
      ctx.pending.length > 0 ? Math.floor(tokens / ctx.pending.length) : 0;
    for (const tu of ctx.pending) {
      const t = acc.tools.get(tu.name);
      if (t) t.tokens += per;
    }
    ctx.pending = [];
  }
}

/** Read a transcript file's lines, bounded by size; [] on any failure. */
function readLines(file: string): string[] {
  let size = 0;
  try {
    size = statSync(file).size;
  } catch {
    return [];
  }
  if (size > MAX_FILE_BYTES) return [];
  try {
    return readFileSync(file, "utf8").split("\n");
  } catch {
    return [];
  }
}

/** Claude Code transcript roots, including config-dir overrides (best-effort). */
function claudeProjectDirs(): string[] {
  const dirs = [CLAUDE_PROJECTS];
  const cfg = process.env.CLAUDE_CONFIG_DIR;
  if (cfg) dirs.push(join(cfg, "projects"));
  dirs.push(join(homedir(), ".config", "claude", "projects"));
  return [...new Set(dirs)];
}

/** Recursively list *.jsonl files under a dir, newest first, bounded. */
function listTranscripts(dir: string): string[] {
  const out: Array<{ path: string; mtime: number }> = [];
  const walk = (d: string) => {
    if (out.length >= MAX_FILES) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && e.name.endsWith(".jsonl")) {
        try {
          out.push({ path: p, mtime: statSync(p).mtimeMs });
        } catch {
          /* unreadable — skip */
        }
      }
    }
  };
  walk(dir);
  return out
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, MAX_FILES)
    .map((f) => f.path);
}

/**
 * Parse local agent transcripts into tool/skill/project/subagent/title rollups.
 * Sources: Claude Code (`~/.claude/projects`, plus `CLAUDE_CONFIG_DIR` /
 * `~/.config/claude` overrides) and Codex (`~/.codex/sessions`). ccusage already
 * aggregates many agents for token *totals*; this adds the per-agent attribution
 * (which tools/MCP servers, which projects, subagent share) that only lives in
 * the transcripts. Returns empties when nothing is available — never throws.
 */
export async function collectAttribution(): Promise<AttributionResult> {
  const acc = createAccumulator();
  const deadline = Date.now() + TIME_BUDGET_MS;
  let complete = true;
  // Hand the event loop back every few files so the spinner/loading bar keeps
  // painting (and concurrent ccusage children keep draining) instead of freezing
  // while a big transcript folder is parsed on the main thread.
  let sinceYield = 0;
  const breathe = async () => {
    if (++sinceYield >= 8) {
      sinceYield = 0;
      await new Promise((r) => setImmediate(r));
    }
  };
  try {
    // Claude Code — rich format (tool_use, attributionSkill, isSidechain, cwd).
    for (const dir of claudeProjectDirs()) {
      for (const file of listTranscripts(dir)) {
        if (Date.now() > deadline) {
          complete = false;
          break;
        }
        const ctx = createFileContext();
        for (const line of readLines(file)) {
          if (!line) continue;
          try {
            processRecord(JSON.parse(line), acc, ctx);
          } catch {
            /* malformed line — skip */
          }
        }
        await breathe();
      }
    }
    // Codex — rollout format (function_call, token_count, session cwd/model).
    for (const file of listTranscripts(CODEX_SESSIONS)) {
      if (Date.now() > deadline) {
        complete = false;
        break;
      }
      const ctx = createCodexContext();
      for (const line of readLines(file)) {
        if (!line) continue;
        try {
          processCodexRecord(JSON.parse(line), acc, ctx);
        } catch {
          /* malformed line — skip */
        }
      }
      await breathe();
    }
  } catch {
    /* anything unexpected — return whatever we have (mark partial) */
    complete = false;
  }
  return { ...accumulatorToResult(acc), complete };
}
