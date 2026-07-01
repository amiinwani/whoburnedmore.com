/**
 * Native Claude Code usage reader.
 *
 * Why this exists: we used to depend entirely on the third-party `ccusage`
 * binary to read Claude Code's local logs, but it has confirmed miscount bugs —
 * it both OVER-counts (re-counting forked/duplicated sessions) and UNDER-counts
 * (its keep-FIRST dedup drops the final token value of a streamed message,
 * ccusage#888). On this maintainer's own machine the raw transcript sum was
 * 1.3-5.9x ccusage's number on recent days. So we parse the raw transcripts
 * ourselves with the correct dedup rule and, crucially, emit a structural
 * fingerprint (the count of DISTINCT provider requests) that the server uses as
 * an anti-fraud signal.
 *
 * Claude Code writes append-only JSON Lines to
 * `<configDir>/projects/<slug>/<session-uuid>.jsonl`. Each assistant turn is one
 * logical request identified by `message.id` (msg_...) + top-level `requestId`
 * (req_...). While a response streams, Claude Code writes several intermediate
 * lines that SHARE that id pair but carry placeholder/partial token values; the
 * final line carries the real totals. The correct aggregation therefore dedups
 * by (message.id, requestId) keeping the MAXIMAL token entry — never the first
 * (undercount) and never the sum of all of them (overcount).
 *
 * This module is split into a PURE core (`aggregateClaudeLines`) that the unit
 * tests drive with fixtures, and a thin filesystem wrapper (`collectClaudeNative`).
 */
import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { DailyUsageEntry } from "../shared.js";
import { estimateCostUSD } from "../pricing.js";

/** One deduped provider request extracted from a transcript line. */
export interface ParsedRequest {
  /** Stable identity for a single provider request (msg id + req id). */
  key: string;
  /** True when the key is backed by a real provider id (not a synthetic one). */
  hasRealId: boolean;
  /** Local-calendar date (YYYY-MM-DD), matching ccusage's local-tz bucketing. */
  date: string;
  /** Epoch milliseconds of this line's timestamp (0 if unparseable). Used by the
   *  `verify` skeleton for the physical-throughput forensic check. */
  ts: number;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}

function num(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Total of the four token fields. */
function reqTokens(r: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}): number {
  return (
    r.inputTokens + r.outputTokens + r.cacheCreationTokens + r.cacheReadTokens
  );
}

/**
 * Convert an ISO timestamp to a local YYYY-MM-DD. ccusage buckets days in the
 * user's local timezone, and the rest of our pipeline (leaderboard, anti-cheat
 * future-date skew) already assumes local dates, so we match that here.
 */
function localDate(iso: string): string | null {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

let syntheticCounter = 0;

/**
 * Parse one transcript line into a request, or null if it carries no usage.
 * Counts assistant messages that have a `message.usage` object — including
 * subagent sidechain lines, which consume real tokens and must be counted.
 */
export function parseClaudeLine(raw: string): ParsedRequest | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    return null;
  }
  const message = obj.message as Record<string, unknown> | undefined;
  if (!message || typeof message !== "object") return null;
  const usage = message.usage as Record<string, unknown> | undefined;
  if (!usage || typeof usage !== "object") return null;
  // Only assistant turns carry billable usage; user/summary lines never do, but
  // guard anyway in case a non-assistant line ever sprouts a usage stub.
  if (message.role !== undefined && message.role !== "assistant") return null;

  const date = localDate(String(obj.timestamp ?? ""));
  if (!date) return null;
  const tsParsed = Date.parse(String(obj.timestamp ?? ""));
  const ts = Number.isFinite(tsParsed) ? tsParsed : 0;

  const messageId = typeof message.id === "string" ? message.id : "";
  const requestId = typeof obj.requestId === "string" ? obj.requestId : "";
  const hasRealId = messageId !== "" || requestId !== "";
  // No provider ids at all (shouldn't happen for assistant turns) — give the
  // line its own synthetic key so it is always counted, never merged away.
  const key = hasRealId
    ? `${messageId}|${requestId}`
    : `synthetic|${date}|${(syntheticCounter += 1)}`;

  return {
    key,
    hasRealId,
    date,
    ts,
    model: typeof message.model === "string" ? message.model : "unknown",
    inputTokens: num(usage.input_tokens),
    outputTokens: num(usage.output_tokens),
    cacheCreationTokens: num(usage.cache_creation_input_tokens),
    cacheReadTokens: num(usage.cache_read_input_tokens),
  };
}

/** The running dedup state: the maximal-token request per (message.id,requestId). */
export type ClaudeAccumulator = Map<string, ParsedRequest>;

/**
 * Fold a batch of transcript lines into an EXISTING accumulator. Dedup rule:
 * group by (message.id, requestId) and keep the MAXIMAL-token occurrence — this
 * collapses streamed intermediate lines (partial counts) to the one true final
 * count, fixing both the undercount (keep-first) and overcount (sum-of-all)
 * modes. Streaming files through one shared accumulator keeps peak memory at the
 * size of the deduped request set (bounded by the number of real requests), NOT
 * the whole on-disk corpus — the 852MB-resident OOM trap of reading every file
 * first.
 */
export function accumulateClaudeLines(
  acc: ClaudeAccumulator,
  lines: Iterable<string>,
): void {
  for (const line of lines) {
    const r = parseClaudeLine(line);
    if (!r) continue;
    const prev = acc.get(r.key);
    if (!prev || reqTokens(r) > reqTokens(prev)) acc.set(r.key, r);
  }
}

/** Group a deduped accumulator into per-(date, model) daily entries. */
export function finalizeClaudeEntries(acc: ClaudeAccumulator): DailyUsageEntry[] {
  interface Bucket {
    date: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    requestCount: number;
  }
  const byDayModel = new Map<string, Bucket>();
  for (const r of acc.values()) {
    const k = `${r.date}|${r.model}`;
    let b = byDayModel.get(k);
    if (!b) {
      b = {
        date: r.date,
        model: r.model,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
        requestCount: 0,
      };
      byDayModel.set(k, b);
    }
    b.inputTokens += r.inputTokens;
    b.outputTokens += r.outputTokens;
    b.cacheCreationTokens += r.cacheCreationTokens;
    b.cacheReadTokens += r.cacheReadTokens;
    // Only real provider ids count toward the fingerprint — a synthetic-keyed
    // line (no ids) is NOT evidence of a real request.
    if (r.hasRealId) b.requestCount += 1;
  }

  const entries: DailyUsageEntry[] = [];
  for (const b of byDayModel.values()) {
    const tokens =
      b.inputTokens + b.outputTokens + b.cacheCreationTokens + b.cacheReadTokens;
    if (tokens === 0) continue;
    entries.push({
      date: b.date,
      tool: "claude",
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
 * Aggregate raw transcript lines into per-(date, model) daily entries (the
 * one-shot, all-in-memory convenience over `accumulateClaudeLines` +
 * `finalizeClaudeEntries`, used by tests and the offline measurement script).
 */
export function aggregateClaudeLines(
  lines: Iterable<string>,
): DailyUsageEntry[] {
  const acc: ClaudeAccumulator = new Map();
  accumulateClaudeLines(acc, lines);
  return finalizeClaudeEntries(acc);
}

/**
 * Resolve the Claude Code config directories to scan. Honors `CLAUDE_CONFIG_DIR`
 * (a single dir or comma-separated list — the same override ccusage respects);
 * otherwise scans BOTH `~/.claude` and `~/.config/claude`, since Claude Code
 * migrated toward the XDG location and a user's data can live in either (a real
 * ccusage failure mode is scanning only one). Returns the `<dir>/projects` roots.
 */
export function resolveClaudeConfigRoots(env = process.env): string[] {
  const override = env.CLAUDE_CONFIG_DIR;
  return override
    ? override
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    : [join(homedir(), ".claude"), join(homedir(), ".config", "claude")];
}

export function resolveClaudeProjectDirs(env = process.env): string[] {
  return resolveClaudeConfigRoots(env).map((r) => join(r, "projects"));
}

/** Recursively list every `*.jsonl` file under a directory (best effort). */
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
    if (d.isDirectory()) {
      out.push(...(await listJsonl(full)));
    } else if (d.isFile() && d.name.endsWith(".jsonl")) {
      out.push(full);
    }
  }
  return out;
}

export interface NativeCollectResult {
  entries: DailyUsageEntry[];
  /** True when at least one transcript file was found (whether or not it had usage). */
  found: boolean;
  filesScanned: number;
  /** True when the read abandoned early on its time budget (caller should fall back). */
  timedOut?: boolean;
}

/**
 * Wall-clock budget for the whole native Claude read. Kept just under ccusage's
 * per-source 25s timeout so that, on a machine where the corpus is too large to
 * read in time, the native path bows out and the existing ccusage fallback runs
 * instead of the run hanging. Tunable for tests.
 */
export const NATIVE_READ_BUDGET_MS = 20_000;

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

/**
 * Read every Claude Code transcript on disk and aggregate it. Best effort: an
 * unreadable file is skipped, and a missing config dir yields `found:false` so
 * the caller can fall back to ccusage.
 *
 * Memory- and time-bounded: files are read ONE AT A TIME and folded into a
 * shared dedup accumulator (peak memory = one file + the deduped request set,
 * NOT the whole corpus), and the read abandons on a wall-clock budget. On
 * timeout it returns `found:false` so the caller falls back to ccusage rather
 * than submitting a partial (undercounted) total — and never OOM-crashes the run.
 */
export async function collectClaudeNative(
  env = process.env,
  opts: { budgetMs?: number; now?: () => number } = {},
): Promise<NativeCollectResult> {
  const dirs = resolveClaudeProjectDirs(env);
  const files: string[] = [];
  for (const dir of dirs) files.push(...(await listJsonl(dir)));
  if (files.length === 0) return { entries: [], found: false, filesScanned: 0 };

  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS);
  const acc: ClaudeAccumulator = new Map();
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
    accumulateClaudeLines(acc, splitLines(content));
    scanned += 1;
    // `content` is now unreferenced and collectable before the next file.
  }
  return { entries: finalizeClaudeEntries(acc), found: true, filesScanned: scanned };
}

/**
 * Per-request skeleton for `whoburnedmore verify`: the DEDUPED provider requests
 * (each carrying its timestamp), NOT aggregated to daily. Reuses the exact same
 * read + dedup as `collectClaudeNative` — so the totals line up with what was
 * submitted — but returns one record per distinct request so the server can run
 * its forensic checks (internal consistency, physical throughput, request
 * density). Still content-free: only token counts, model, timestamp, and the
 * (message-id, request-id) key. Best-effort, time-bounded like the aggregate read.
 */
export async function collectClaudeRequests(
  env = process.env,
  opts: { budgetMs?: number; now?: () => number } = {},
): Promise<{ requests: ParsedRequest[]; found: boolean; timedOut?: boolean }> {
  const dirs = resolveClaudeProjectDirs(env);
  const files: string[] = [];
  for (const dir of dirs) files.push(...(await listJsonl(dir)));
  if (files.length === 0) return { requests: [], found: false };

  const now = opts.now ?? Date.now;
  const deadline = now() + (opts.budgetMs ?? NATIVE_READ_BUDGET_MS);
  const acc: ClaudeAccumulator = new Map();
  for (const f of files) {
    if (now() > deadline) {
      return { requests: [...acc.values()], found: true, timedOut: true };
    }
    let content: string;
    try {
      content = await readFile(f, "utf8");
    } catch {
      continue; // skip unreadable file
    }
    accumulateClaudeLines(acc, splitLines(content));
  }
  return { requests: [...acc.values()], found: true };
}
