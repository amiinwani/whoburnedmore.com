/**
 * Native Codex (OpenAI CLI) usage reader.
 *
 * Codex writes one "rollout" JSONL per session under
 * `<CODEX_HOME>/sessions/YYYY/MM/DD/rollout-<ts>-<session-uuid>.jsonl`
 * (default `~/.codex`). Each line is `{timestamp, type, payload}`. Token usage is
 * reported by `event_msg` lines whose `payload.type === "token_count"`, and those
 * totals are CUMULATIVE for the session — every turn re-reports the running total
 * (older builds inline the fields; newer builds nest them under
 * `payload.info.total_token_usage`). So a session's true usage is the LAST
 * token_count event, never the sum of them (summing is the classic Codex
 * triple-count bug). The model comes from `turn_context` / `session_meta`.
 *
 * As with Claude, this is split into a PURE core the tests drive
 * (`parseCodexRollout`, `aggregateCodexSessions`) and a filesystem wrapper.
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DailyUsageEntry } from "../shared.js";
import { estimateCostUSD } from "../pricing.js";

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function localDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** Pull the cumulative token fields out of a token_count payload (both layouts). */
function readTokenFields(payload: Record<string, unknown>): {
  input: number;
  cached: number;
  output: number;
  reasoning: number;
} | null {
  // Newer builds nest the running total under info.total_token_usage.
  const info = payload.info as Record<string, unknown> | undefined;
  const src =
    (info?.total_token_usage as Record<string, unknown> | undefined) ?? payload;
  const input = src.input_tokens;
  const output = src.output_tokens;
  if (input === undefined && output === undefined) return null;
  return {
    input: num(input),
    cached: num(src.cached_input_tokens),
    output: num(output),
    reasoning: num(src.reasoning_output_tokens),
  };
}

export interface CodexSession {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  /** Number of token_count (turn) events — the structural fingerprint proxy. */
  turnCount: number;
}

/**
 * Parse one session's rollout lines into PER-DAY usage records (one per local
 * day the session was active), or an empty array if it reported no usage.
 *
 * Codex token_count events carry the session's RUNNING CUMULATIVE total (every
 * turn re-reports the running total, not a delta). A single rollout file can
 * span many calendar days, so attributing the whole cumulative to the last
 * event's day — as this once did — dumps a multi-day session's entire total onto
 * one day and massively inflates that day's board number. Instead we bucket each
 * token_count by its OWN local day, keep the last cumulative seen on each day,
 * and emit each day's INCREMENTAL usage (that day's ending cumulative minus the
 * previous active day's ending cumulative). Because the cumulative is monotonic,
 * those per-day deltas sum back to the session total with no double-counting.
 */
export function parseCodexRollout(lines: Iterable<string>): CodexSession[] {
  let model = "unknown";
  // Per local day: the LAST cumulative seen that day + turn count that day.
  // Insertion order follows the (chronological) event stream.
  const perDay = new Map<
    string,
    { cum: { input: number; cached: number; output: number; reasoning: number }; turns: number }
  >();
  let lastSeenDate: string | null = null;

  for (const raw of lines) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const payload = obj.payload as Record<string, unknown> | undefined;
    if (!payload || typeof payload !== "object") continue;

    // The line kind is on the OUTER `type` (session_meta / turn_context /
    // event_msg); only event_msg carries a payload.type sub-discriminator.
    const kind = obj.type;
    if (kind === "session_meta" || kind === "turn_context") {
      if (typeof payload.model === "string" && payload.model) model = payload.model;
    }
    if (payload.type === "token_count") {
      const fields = readTokenFields(payload);
      if (!fields) continue;
      // Attribute to the event's own day; if the timestamp is unparseable, carry
      // forward the most recent known day rather than dropping the usage.
      const parsed: string | null = localDate(String(obj.timestamp ?? ""));
      const day: string | null = parsed ?? lastSeenDate;
      if (!day) continue;
      lastSeenDate = day;
      const e = perDay.get(day);
      if (e) {
        e.cum = fields; // latest cumulative on that day
        e.turns += 1;
      } else {
        perDay.set(day, { cum: fields, turns: 1 });
      }
    }
  }

  if (perDay.size === 0) return [];

  // Walk days oldest→newest and difference the cumulative to get each day's
  // own usage. Map Codex's cumulative fields onto our four-field schema:
  //  - cache read  = cached input portion
  //  - input       = uncached input (input_tokens already includes the cached part)
  //  - output      = visible output + reasoning output (both billed as output)
  //  - cache create= Codex doesn't report a separate cache-write count
  const dates = [...perDay.keys()].sort();
  const out: CodexSession[] = [];
  let prev = { input: 0, cached: 0, output: 0, reasoning: 0 };
  for (const date of dates) {
    const { cum, turns } = perDay.get(date)!;
    // Per-day deltas (monotonic cumulative ⇒ non-negative; max(0) guards any reset).
    const dInput = Math.max(0, cum.input - prev.input);
    const dCached = Math.max(0, cum.cached - prev.cached);
    const dOutput = Math.max(0, cum.output - prev.output);
    const dReasoning = Math.max(0, cum.reasoning - prev.reasoning);
    prev = cum;
    const cacheReadTokens = dCached;
    const inputTokens = Math.max(0, dInput - dCached);
    const outputTokens = dOutput + dReasoning;
    if (inputTokens + outputTokens + cacheReadTokens === 0) continue; // idle day
    out.push({
      date,
      model,
      inputTokens,
      outputTokens,
      cacheCreationTokens: 0,
      cacheReadTokens,
      turnCount: turns,
    });
  }
  return out;
}

interface CodexBucket {
  date: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  requestCount: number;
}
/** Running per-(date,model) accumulator across streamed sessions. */
export type CodexAccumulator = Map<string, CodexBucket>;

/** Parse one session's lines and fold its per-day records into an accumulator. */
export function accumulateCodexSession(
  acc: CodexAccumulator,
  lines: Iterable<string>,
): void {
  for (const s of parseCodexRollout(lines)) {
    const k = `${s.date}|${s.model}`;
    let b = acc.get(k);
    if (!b) {
      b = {
        date: s.date,
        model: s.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        requestCount: 0,
      };
      acc.set(k, b);
    }
    b.inputTokens += s.inputTokens;
    b.outputTokens += s.outputTokens;
    b.cacheCreationTokens += s.cacheCreationTokens;
    b.cacheReadTokens += s.cacheReadTokens;
    b.requestCount += s.turnCount;
  }
}

/** Group a Codex accumulator into per-(date,model) daily entries. */
export function finalizeCodexEntries(acc: CodexAccumulator): DailyUsageEntry[] {
  const entries: DailyUsageEntry[] = [];
  for (const b of acc.values()) {
    entries.push({
      date: b.date,
      tool: "codex",
      model: b.model,
      inputTokens: b.inputTokens,
      outputTokens: b.outputTokens,
      cacheCreationTokens: b.cacheCreationTokens,
      cacheReadTokens: b.cacheReadTokens,
      costUSD: estimateCostUSD(b.model, b),
      origin: "cli",
      verified: false,
      requestCount: b.requestCount,
    });
  }
  return entries;
}

/**
 * Aggregate many parsed sessions into per-(date, model) daily entries (one-shot
 * over accumulate + finalize, used by tests). `requestCount` = total turn events
 * across sessions in a bucket (a forged Codex day has zero real turns).
 */
export function aggregateCodexSessions(
  sessions: Array<Iterable<string>>,
): DailyUsageEntry[] {
  const acc: CodexAccumulator = new Map();
  for (const lines of sessions) accumulateCodexSession(acc, lines);
  return finalizeCodexEntries(acc);
}

/** Resolve the Codex sessions root (honors CODEX_HOME, default ~/.codex). */
export function resolveCodexSessionsDir(env = process.env): string {
  const home = env.CODEX_HOME && env.CODEX_HOME.trim() ? env.CODEX_HOME.trim() : join(homedir(), ".codex");
  return join(home, "sessions");
}

async function listJsonl(dir: string): Promise<string[]> {
  let dirents;
  try {
    dirents = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const d of dirents) {
    const full = join(dir, d.name);
    if (d.isDirectory()) out.push(...(await listJsonl(full)));
    else if (d.isFile() && d.name.endsWith(".jsonl")) out.push(full);
  }
  return out;
}

function* splitLines(content: string): Generator<string> {
  let start = 0;
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") {
      yield content.slice(start, i);
      start = i + 1;
    }
  }
  if (start < content.length) yield content.slice(start);
}

export interface NativeCollectResult {
  entries: DailyUsageEntry[];
  found: boolean;
  filesScanned: number;
  timedOut?: boolean;
}

/** Wall-clock budget for the whole native Codex read (see claude.ts). */
export const NATIVE_READ_BUDGET_MS = 20_000;

/**
 * Read every Codex rollout on disk and aggregate it. Best effort, and memory-
 * and time-bounded: each rollout is read, parsed, and folded into a per-session
 * accumulator ONE AT A TIME (peak memory = one rollout + the small per-day map,
 * not every rollout at once — Codex `~/.codex/sessions` is hundreds of MB), and
 * the read abandons on a wall-clock budget, returning `found:false` so the
 * caller falls back to ccusage rather than hanging or OOM-crashing the run.
 */
export async function collectCodexNative(
  env = process.env,
  opts: { budgetMs?: number; now?: () => number } = {},
): Promise<NativeCollectResult> {
  const dir = resolveCodexSessionsDir(env);
  const files = await listJsonl(dir);
  if (files.length === 0) return { entries: [], found: false, filesScanned: 0 };
  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS);
  const acc: CodexAccumulator = new Map();
  let scanned = 0;
  for (const f of files) {
    if (now() > deadline) {
      return { entries: [], found: false, filesScanned: scanned, timedOut: true };
    }
    let content: string;
    try {
      content = await readFile(f, "utf8");
    } catch {
      continue; // skip unreadable file
    }
    accumulateCodexSession(acc, splitLines(content));
    scanned += 1;
  }
  return { entries: finalizeCodexEntries(acc), found: true, filesScanned: scanned };
}
