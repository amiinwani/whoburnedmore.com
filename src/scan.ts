/**
 * Reads local AI-agent session transcripts and adds up how many tokens you burned.
 * Everything happens on your machine — this module opens files under your home
 * directory, parses them, and returns numbers. It never makes a network call.
 *
 * Two transcript formats are supported, folded into one aggregation:
 *   - Claude Code: ~/.claude/projects/<slugified-cwd>/<session-id>.jsonl — one JSON
 *     object per line; assistant turns carry `message.usage` + `message.model`.
 *   - OpenAI Codex: ~/.codex/sessions/**.jsonl (rollout records) — session-meta /
 *     turn-context carry cwd+model, tool calls are function/custom/local-shell calls,
 *     and a `token_count` record closes each turn with the usage numbers.
 *
 * Every aggregated entry is tagged with an `agent` ("claude-code" | "codex") so the
 * report can break usage down per agent. Day bucketing is UTC (a documented caveat).
 */
import { readdirSync, statSync, createReadStream } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { estimateCost } from "./pricing.js";

/** Agent source tag for an aggregated entry. */
export type Agent = "claude-code" | "codex";

/** Hard bounds so a pathological transcript store can never hang or OOM the CLI. */
const MAX_FILE_BYTES = 64 * 1024 * 1024; // skip files larger than 64 MB
const MAX_FILES = 5000; // cap the number of transcript files scanned

export interface Bucket {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  tokens: number;
  costUSD: number;
  messages: number;
}

/** Per-tool attribution: how many times a tool was called, how often it errored. */
export interface ToolBucket {
  count: number;
  errors: number;
  tokens: number;
}

/** Per-skill attribution (only populated if transcripts carry a skill field). */
export interface SkillBucket {
  count: number;
  tokens: number;
}

export interface Report {
  totals: Bucket;
  byModel: Map<string, Bucket>;
  byProject: Map<string, Bucket>;
  byDay: Map<string, Bucket>;
  byAgent: Map<Agent, Bucket>;
  byTool: Map<string, ToolBucket>;
  bySkill: Map<string, SkillBucket>;
  /** Tokens spent on subagent (sidechain) assistant turns. */
  subagentTokens: number;
  subagentMessages: number;
  /** Count of real, human-typed user turns (the denominator for per-message averages). */
  humanMessages: number;
  firstDate: string | null;
  lastDate: string | null;
  sessions: number;
  filesScanned: number;
}

function emptyBucket(): Bucket {
  return { input: 0, output: 0, cacheWrite: 0, cacheRead: 0, tokens: 0, costUSD: 0, messages: 0 };
}

export function emptyReport(): Report {
  return {
    totals: emptyBucket(),
    byModel: new Map(),
    byProject: new Map(),
    byDay: new Map(),
    byAgent: new Map(),
    byTool: new Map(),
    bySkill: new Map(),
    subagentTokens: 0,
    subagentMessages: 0,
    humanMessages: 0,
    firstDate: null,
    lastDate: null,
    sessions: 0,
    filesScanned: 0,
  };
}

/** The default place Claude Code keeps its transcripts. */
export function defaultDataDir(): string {
  return join(homedir(), ".claude", "projects");
}

/** The default place OpenAI Codex keeps its session rollouts. */
export function defaultCodexDir(): string {
  return join(homedir(), ".codex", "sessions");
}

/** Turn a project path like /Users/me/code/app into a short label "app". */
function projectLabel(cwd: string | undefined): string {
  if (!cwd) return "unknown";
  return basename(cwd) || "unknown";
}

/** Recursively collect every *.jsonl file under `dir`, capped + size-bounded. */
function findTranscripts(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    if (out.length >= MAX_FILES) return;
    let entries: string[];
    try {
      entries = readdirSync(d);
    } catch {
      return;
    }
    for (const name of entries) {
      if (out.length >= MAX_FILES) return;
      const full = join(d, name);
      let s;
      try {
        s = statSync(full);
      } catch {
        continue;
      }
      if (s.isDirectory()) walk(full);
      else if (name.endsWith(".jsonl") && s.size <= MAX_FILE_BYTES) out.push(full);
    }
  };
  walk(dir);
  return out;
}

// ---------------------------------------------------------------------------
// Shared token folding
// ---------------------------------------------------------------------------

interface TokenAddition {
  input: number;
  output: number;
  cacheWrite: number;
  cacheRead: number;
  model: string;
  cwd: string | undefined;
  agent: Agent;
  /** ISO timestamp, if known, for day bucketing. */
  timestamp?: string;
  /** True if this turn is a subagent / sidechain record (Claude only). */
  sidechain?: boolean;
}

function bumpBucket(map: Map<string, Bucket>, key: string, add: (b: Bucket) => void): void {
  let b = map.get(key);
  if (!b) {
    b = emptyBucket();
    map.set(key, b);
  }
  add(b);
}

/** Add one closed turn's tokens into all the bucketed dimensions of the report. */
function foldTurn(report: Report, a: TokenAddition): { tokens: number; cost: number } {
  const tokens = a.input + a.output + a.cacheWrite + a.cacheRead;
  const cost = estimateCost(a.model, {
    input: a.input,
    output: a.output,
    cacheWrite: a.cacheWrite,
    cacheRead: a.cacheRead,
  });
  if (tokens === 0) return { tokens: 0, cost: 0 };

  const add = (b: Bucket) => {
    b.input += a.input;
    b.output += a.output;
    b.cacheWrite += a.cacheWrite;
    b.cacheRead += a.cacheRead;
    b.tokens += tokens;
    b.costUSD += cost;
    b.messages += 1;
  };

  add(report.totals);
  bumpBucket(report.byModel, a.model, add);
  bumpBucket(report.byProject, projectLabel(a.cwd), add);
  bumpBucket(report.byAgent as Map<string, Bucket>, a.agent, add);

  if (a.sidechain) {
    report.subagentTokens += tokens;
    report.subagentMessages += 1;
  }

  const ts = a.timestamp ? Date.parse(a.timestamp) : NaN;
  if (Number.isFinite(ts)) {
    const day = new Date(ts).toISOString().slice(0, 10);
    bumpBucket(report.byDay, day, add);
    if (!report.firstDate || day < report.firstDate) report.firstDate = day;
    if (!report.lastDate || day > report.lastDate) report.lastDate = day;
  }
  return { tokens, cost };
}

/** Attribute a turn's tokens evenly across the tools it invoked. */
function foldTools(report: Report, names: string[], turnTokens: number): void {
  if (names.length === 0) return;
  const share = turnTokens / names.length;
  for (const name of names) {
    let b = report.byTool.get(name);
    if (!b) {
      b = { count: 0, errors: 0, tokens: 0 };
      report.byTool.set(name, b);
    }
    b.count += 1;
    b.tokens += share;
  }
}

// ---------------------------------------------------------------------------
// Claude Code transcripts
// ---------------------------------------------------------------------------

/** A line of a Claude Code transcript, with only the fields we care about. */
interface ClaudeRecord {
  type?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  toolUseResult?: unknown;
  message?: {
    role?: string;
    model?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
    content?: unknown;
  };
  /** Some transcripts annotate the skill that drove a turn. Optional. */
  skill?: string;
  skillName?: string;
}

/** Is a user record a real, human-typed turn (vs. tool-result / meta / injected)? */
export function isHumanUserMessage(rec: ClaudeRecord): boolean {
  if (rec.type !== "user") return false;
  if (rec.isSidechain) return false; // subagent-driven, not the human
  if (rec.isMeta) return false; // meta bookkeeping records
  if (rec.message?.role && rec.message.role !== "user") return false;

  const content = rec.message?.content;
  // Tool-result-only turns: content is an array whose blocks are all tool_result.
  if (Array.isArray(content)) {
    const blocks = content as Array<{ type?: string }>;
    if (blocks.length > 0 && blocks.every((b) => b?.type === "tool_result")) return false;
    const text = blocks
      .filter((b) => b?.type === "text")
      .map((b) => (b as { text?: string }).text ?? "")
      .join("\n");
    return isHumanText(text);
  }
  if (typeof content === "string") return isHumanText(content);
  return false;
}

/** Heuristics for excluding injected / synthetic user text from the human count. */
function isHumanText(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (t.startsWith("Caveat:")) return false; // injected preamble
  if (t.startsWith("<command-name>") || t.startsWith("<command-message>")) return false; // slash-command expansion
  if (t.startsWith("<local-command-stdout>")) return false;
  if (t.startsWith("<system-reminder>")) return false; // injected reminder
  if (t.startsWith("[Request interrupted")) return false;
  return true;
}

/** Per-file mutable state for matching tool errors back to their tool_use. */
interface ClaudeFileState {
  /** tool_use_id -> tool name, so an is_error result can find its tool. */
  toolNameById: Map<string, string>;
}

/** Fold one parsed Claude record into the report. Exported for unit tests. */
export function applyRecord(
  report: Report,
  rec: ClaudeRecord,
  sinceMs: number | null,
  state: ClaudeFileState = { toolNameById: new Map() },
): void {
  // Human-typed user turns: the denominator for per-message averages.
  if (rec.type === "user") {
    if (isHumanUserMessage(rec)) report.humanMessages += 1;
    matchToolErrors(report, rec, state);
    return;
  }

  if (rec.type !== "assistant") return;
  const usage = rec.message?.usage;
  if (!usage) return;

  const ts = rec.timestamp ? Date.parse(rec.timestamp) : NaN;
  if (sinceMs !== null && Number.isFinite(ts) && ts < sinceMs) return;

  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const model = rec.message?.model ?? "unknown";

  const { tokens } = foldTurn(report, {
    input,
    output,
    cacheWrite,
    cacheRead,
    model,
    cwd: rec.cwd,
    agent: "claude-code",
    timestamp: rec.timestamp,
    sidechain: rec.isSidechain === true,
  });
  if (tokens === 0) return;

  // Tool attribution: names from this assistant turn, ids tracked for error matching.
  const blocks = assistantToolBlocks(rec.message?.content);
  foldTools(report, blocks.map((b) => b.name), tokens);
  for (const { id, name } of blocks) {
    if (id) state.toolNameById.set(id, name);
  }

  // Optional skill attribution.
  const skill = rec.skill ?? rec.skillName;
  if (typeof skill === "string" && skill) {
    let b = report.bySkill.get(skill);
    if (!b) {
      b = { count: 0, tokens: 0 };
      report.bySkill.set(skill, b);
    }
    b.count += 1;
    b.tokens += tokens;
  }
}

/** Tool-use blocks with both id and name, for error matching. */
function assistantToolBlocks(content: unknown): Array<{ id?: string; name: string }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id?: string; name: string }> = [];
  for (const block of content as Array<{ type?: string; id?: string; name?: string }>) {
    if (block?.type === "tool_use" && typeof block.name === "string") {
      out.push({ id: block.id, name: block.name });
    }
  }
  return out;
}

/** Match is_error tool_result blocks (in a user turn) back to their tool_use. */
function matchToolErrors(report: Report, rec: ClaudeRecord, state: ClaudeFileState): void {
  const content = rec.message?.content;
  if (!Array.isArray(content)) return;
  for (const block of content as Array<{ type?: string; tool_use_id?: string; is_error?: boolean }>) {
    if (block?.type === "tool_result" && block.is_error === true && block.tool_use_id) {
      const name = state.toolNameById.get(block.tool_use_id);
      if (name) {
        const b = report.byTool.get(name);
        if (b) b.errors += 1;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// OpenAI Codex rollouts
// ---------------------------------------------------------------------------

/** A line of a Codex rollout file (only the fields we read). */
interface CodexRecord {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
  [k: string]: unknown;
}

/** Per-file Codex state: the current cwd + model and pending tool calls. */
interface CodexFileState {
  cwd: string | undefined;
  model: string;
  pending: string[];
}

function asObj(v: unknown): Record<string, unknown> | undefined {
  return v && typeof v === "object" ? (v as Record<string, unknown>) : undefined;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * Fold one Codex rollout record into the report. Codex has no subagents, so the
 * subagent counters stay 0. Exported for unit tests with synthetic records.
 */
export function applyCodexRecord(
  report: Report,
  rec: CodexRecord,
  sinceMs: number | null,
  state: CodexFileState,
): void {
  // Records may be flat or wrapped in a `payload`. Read from whichever carries data.
  const type = rec.type ?? str(rec.payload?.type);
  const body = asObj(rec.payload) ?? rec;

  // session-meta / turn-context: pick up cwd + model.
  if (type === "session_meta" || type === "turn_context" || type === "turn-context") {
    const cwd = str(body.cwd) ?? str(asObj(body.payload)?.cwd);
    const model = str(body.model) ?? str(asObj(body.payload)?.model);
    if (cwd) state.cwd = cwd;
    if (model) state.model = model;
    return;
  }

  // Tool calls -> push to pending.
  if (
    type === "function_call" ||
    type === "custom_tool_call" ||
    type === "local_shell_call"
  ) {
    const name =
      type === "local_shell_call"
        ? "shell"
        : str(body.name) ?? str(asObj(body.payload)?.name) ?? "tool";
    state.pending.push(name);
    return;
  }

  // token_count: a turn closed.
  if (type === "token_count" || type === "event_msg_token_count") {
    const info = asObj(body.info) ?? asObj(body.usage) ?? asObj(asObj(body.payload)?.info) ?? body;
    const lastUsage = asObj(info.last_token_usage) ?? asObj(info.total_token_usage) ?? info;

    const input = num(lastUsage.input_tokens);
    const cachedInput = num(lastUsage.cached_input_tokens);
    const output = num(lastUsage.output_tokens);
    const reasoning = num(lastUsage.reasoning_output_tokens);

    const ts = rec.timestamp ?? str(body.timestamp);
    const tsMs = ts ? Date.parse(ts) : NaN;
    if (sinceMs !== null && Number.isFinite(tsMs) && tsMs < sinceMs) {
      state.pending = [];
      return;
    }

    // Map Codex usage onto our bucket shape: cached input -> cacheRead, plain input
    // (non-cached) -> input, output + reasoning -> output.
    const plainInput = Math.max(0, input - cachedInput);
    const { tokens } = foldTurn(report, {
      input: plainInput,
      output: output + reasoning,
      cacheWrite: 0,
      cacheRead: cachedInput,
      model: state.model,
      cwd: state.cwd,
      agent: "codex",
      timestamp: ts,
      sidechain: false,
    });

    foldTools(report, state.pending, tokens);
    state.pending = [];
    return;
  }
}

export interface ScanOptions {
  /** Directory of Claude transcripts (defaults to ~/.claude/projects). */
  dir?: string;
  /** Directory of Codex rollouts (defaults to ~/.codex/sessions). */
  codexDir?: string;
  /** Only count usage newer than this many days ago. */
  sinceDays?: number;
  /** If set, only fold this agent's transcripts. */
  agent?: Agent;
}

async function readLines(file: string, onLine: (line: string) => void): Promise<void> {
  await new Promise<void>((resolve) => {
    let rl: ReturnType<typeof createInterface> | undefined;
    try {
      rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
    } catch {
      resolve();
      return;
    }
    rl.on("line", (line) => {
      if (line) onLine(line);
    });
    rl.on("close", resolve);
    rl.on("error", () => resolve()); // a locked/unreadable file is skipped, never fatal
  });
}

/** Scan transcripts on disk and return an aggregated report. Local-only, async I/O. */
export async function scan(opts: ScanOptions = {}): Promise<Report> {
  const dir = opts.dir ?? defaultDataDir();
  const codexDir = opts.codexDir ?? defaultCodexDir();
  const sinceMs =
    opts.sinceDays && opts.sinceDays > 0 ? Date.now() - opts.sinceDays * 86_400_000 : null;

  const report = emptyReport();

  const wantClaude = !opts.agent || opts.agent === "claude-code";
  const wantCodex = !opts.agent || opts.agent === "codex";

  // Claude Code.
  if (wantClaude) {
    const files = findTranscripts(dir);
    report.sessions += files.length;
    for (const file of files) {
      report.filesScanned += 1;
      const state: ClaudeFileState = { toolNameById: new Map() };
      await readLines(file, (line) => {
        let rec: ClaudeRecord;
        try {
          rec = JSON.parse(line);
        } catch {
          return; // skip a malformed line rather than crash the scan
        }
        applyRecord(report, rec, sinceMs, state);
      });
    }
  }

  // OpenAI Codex — no-ops gracefully if the directory is absent.
  if (wantCodex) {
    const files = findTranscripts(codexDir);
    report.sessions += files.length;
    for (const file of files) {
      report.filesScanned += 1;
      const state: CodexFileState = { cwd: undefined, model: "unknown", pending: [] };
      await readLines(file, (line) => {
        let rec: CodexRecord;
        try {
          rec = JSON.parse(line);
        } catch {
          return;
        }
        applyCodexRecord(report, rec, sinceMs, state);
      });
    }
  }

  return report;
}
