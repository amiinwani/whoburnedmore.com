import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
import type {
  AgentStat,
  BlockEntry,
  DailyUsageEntry,
  ProjectStat,
  SessionEntry,
  SkillStat,
  ToolStat,
} from "./shared.js";
import { collectAttribution } from "./attribution.js";
import { collectCursor } from "./cursor.js";

/** Sources ccusage can read, in the order we probe them. */
export const SOURCES = [
  "claude",
  "codex",
  "gemini",
  "copilot",
  "opencode",
  "amp",
  "droid",
  "goose",
  "kimi",
  "qwen",
  "kilo",
  "openclaw",
  "hermes",
  "pi",
  "codebuff",
] as const;

function norm(n: unknown): number {
  const v = Math.round(Number(n));
  return Number.isFinite(v) && v > 0 ? v : 0;
}

function normCost(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/**
 * Map one ccusage daily report (per-source `date` or aggregate `period`
 * variant) to leaderboard entries: one entry per day per model.
 */
export function mapCcusageDaily(
  tool: string,
  json: unknown,
): DailyUsageEntry[] {
  const daily = (json as { daily?: unknown[] } | null)?.daily;
  if (!Array.isArray(daily)) return [];

  const entries: DailyUsageEntry[] = [];
  for (const rawDay of daily) {
    const day = rawDay as Record<string, unknown>;
    const date = (day.date ?? day.period) as string | undefined;
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;

    const breakdowns = Array.isArray(day.modelBreakdowns)
      ? (day.modelBreakdowns as Record<string, unknown>[])
      : [];
    const modelsMap =
      day.models && typeof day.models === "object" && !Array.isArray(day.models)
        ? (day.models as Record<string, Record<string, unknown>>)
        : null;
    const dayCost = normCost(day.totalCost ?? day.costUSD);

    let candidates: Array<{
      model: string;
      inputTokens: number;
      outputTokens: number;
      cacheCreationTokens: number;
      cacheReadTokens: number;
      costUSD: number;
    }>;
    if (breakdowns.length > 0) {
      candidates = breakdowns.map((b) => ({
        model: typeof b.modelName === "string" ? b.modelName : "unknown",
        inputTokens: norm(b.inputTokens),
        outputTokens: norm(b.outputTokens),
        cacheCreationTokens: norm(b.cacheCreationTokens),
        cacheReadTokens: norm(b.cacheReadTokens),
        costUSD: normCost(b.cost),
      }));
    } else if (modelsMap && Object.keys(modelsMap).length > 0) {
      // Codex-style: per-model tokens with only a day-level cost.
      // Attribute the cost proportionally to each model's tokens.
      const partial = Object.entries(modelsMap).map(([model, m]) => ({
        model,
        inputTokens: norm(m.inputTokens),
        outputTokens: norm(m.outputTokens),
        cacheCreationTokens: norm(m.cacheCreationTokens),
        cacheReadTokens: norm(m.cacheReadTokens),
      }));
      const tokenSum = partial.reduce(
        (s, c) =>
          s + c.inputTokens + c.outputTokens + c.cacheCreationTokens + c.cacheReadTokens,
        0,
      );
      candidates = partial.map((c) => {
        const tokens =
          c.inputTokens + c.outputTokens + c.cacheCreationTokens + c.cacheReadTokens;
        return {
          ...c,
          costUSD: tokenSum > 0 ? (dayCost * tokens) / tokenSum : 0,
        };
      });
    } else {
      candidates = [
        {
          model: "unknown",
          inputTokens: norm(day.inputTokens),
          outputTokens: norm(day.outputTokens),
          cacheCreationTokens: norm(day.cacheCreationTokens),
          cacheReadTokens: norm(day.cacheReadTokens),
          costUSD: dayCost,
        },
      ];
    }

    for (const c of candidates) {
      const tokens =
        c.inputTokens +
        c.outputTokens +
        c.cacheCreationTokens +
        c.cacheReadTokens;
      if (tokens === 0 && c.costUSD === 0) continue;
      // CLI-collected usage from local ccusage logs: origin "cli", unverified.
      entries.push({ date, tool, ...c, origin: "cli", verified: false });
    }
  }
  return entries;
}

/** Map `ccusage session` JSON to per-conversation entries (aggregate only). */
export function mapCcusageSessions(json: unknown): SessionEntry[] {
  const sessions = (json as { session?: unknown[] } | null)?.session;
  if (!Array.isArray(sessions)) return [];
  const out: SessionEntry[] = [];
  for (const raw of sessions) {
    const s = raw as Record<string, unknown>;
    const sessionId =
      typeof s.period === "string"
        ? s.period
        : typeof s.sessionId === "string"
          ? s.sessionId
          : null;
    if (!sessionId) continue;
    const inputTokens = norm(s.inputTokens);
    const outputTokens = norm(s.outputTokens);
    const cacheCreationTokens = norm(s.cacheCreationTokens);
    const cacheReadTokens = norm(s.cacheReadTokens);
    if (inputTokens + outputTokens + cacheCreationTokens + cacheReadTokens === 0)
      continue;
    const models = Array.isArray(s.modelsUsed)
      ? (s.modelsUsed as unknown[]).filter((m): m is string => typeof m === "string")
      : [];
    const meta = (s.metadata ?? {}) as { lastActivity?: unknown };
    out.push({
      sessionId: sessionId.slice(0, 128),
      tool: typeof s.agent === "string" ? s.agent : "unknown",
      model: models[0] ?? "unknown",
      inputTokens,
      outputTokens,
      cacheCreationTokens,
      cacheReadTokens,
      costUSD: normCost(s.totalCost ?? s.costUSD),
      lastActivity:
        typeof meta.lastActivity === "string"
          ? meta.lastActivity
          : new Date().toISOString(),
    });
  }
  return out;
}

/** Map `ccusage blocks` JSON to time-window entries for peak-hours analysis. */
export function mapCcusageBlocks(json: unknown): BlockEntry[] {
  const blocks = (json as { blocks?: unknown[] } | null)?.blocks;
  if (!Array.isArray(blocks)) return [];
  const out: BlockEntry[] = [];
  for (const raw of blocks) {
    const b = raw as Record<string, unknown>;
    if (b.isGap === true) continue;
    if (typeof b.startTime !== "string") continue;
    const totalTokens = norm(b.totalTokens);
    const costUSD = normCost(b.costUSD);
    if (totalTokens === 0 && costUSD === 0) continue;
    out.push({ startTime: b.startTime, totalTokens, costUSD });
  }
  return out;
}

/** Locate the ccusage executable installed as our dependency. */
export function resolveCcusageBin(): { cmd: string; prefixArgs: string[] } {
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("ccusage/package.json");
  const pkg = require("ccusage/package.json") as {
    bin?: string | Record<string, string>;
  };
  const rel =
    typeof pkg.bin === "string" ? pkg.bin : (pkg.bin?.ccusage ?? "ccusage");
  const binPath = join(dirname(pkgPath), rel);
  if (/\.(c|m)?js$/.test(binPath)) {
    return { cmd: process.execPath, prefixArgs: [binPath] };
  }
  return { cmd: binPath, prefixArgs: [] };
}

export interface CollectResult {
  entries: DailyUsageEntry[];
  sessions: SessionEntry[];
  blocks: BlockEntry[];
  toolsFound: string[];
  /** Tool-call frequencies parsed from local transcripts (names + counts + errors). */
  tools: ToolStat[];
  /** Skill-usage frequencies parsed from local transcripts. */
  skills: SkillStat[];
  /** Per-project usage totals parsed from local transcripts. */
  projects: ProjectStat[];
  /** Subagent-vs-main rollup parsed from local transcripts. */
  agent: AgentStat;
  /** True when transcript scanning finished within its time budget (full snapshot). */
  attributionComplete: boolean;
}

/**
 * Collapse entries that share a server-side unique key so the payload never
 * contains a duplicate. Sending two rows with the same key makes the API's
 * `bulkWrite` race to insert the same document → a duplicate-key error → a 500
 * ("internal error") for the user. ccusage can legitimately emit such dups
 * (repeated model breakdowns, overlapping block hours, reused session ids), so
 * we merge them here before anything leaves the machine.
 */
export function dedupeDaily(entries: DailyUsageEntry[]): DailyUsageEntry[] {
  const byKey = new Map<string, DailyUsageEntry>();
  for (const e of entries) {
    const key = `${e.date}|${e.tool}|${e.model}|${e.origin}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...e });
      continue;
    }
    // Same (date,tool,model,origin): these are partial counts — sum them.
    prev.inputTokens += e.inputTokens;
    prev.outputTokens += e.outputTokens;
    prev.cacheCreationTokens += e.cacheCreationTokens;
    prev.cacheReadTokens += e.cacheReadTokens;
    prev.costUSD = Number((prev.costUSD + e.costUSD).toFixed(6));
    prev.verified = prev.verified && e.verified;
  }
  return [...byKey.values()];
}

/** Token total of a daily/session entry (the four token fields). */
function entryTokens(e: {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
}): number {
  return e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens;
}

/**
 * Cap an array to the server's accepted maximum, keeping the highest-token rows.
 * A no-op when already within the limit (preserves order). Guards against the
 * server rejecting an oversized payload (zod `.max(...)`) with a 400 — a heavy
 * user gets a capped-but-accepted submit instead of a hard failure.
 */
export function capByTokens<T>(rows: T[], max: number, tokens: (r: T) => number): T[] {
  if (rows.length <= max) return rows;
  return [...rows].sort((a, b) => tokens(b) - tokens(a)).slice(0, max);
}

/** Drop duplicate session ids (keep the row with the most tokens). */
export function dedupeSessions(sessions: SessionEntry[]): SessionEntry[] {
  const byId = new Map<string, SessionEntry>();
  const total = (s: SessionEntry) =>
    s.inputTokens + s.outputTokens + s.cacheCreationTokens + s.cacheReadTokens;
  for (const s of sessions) {
    const prev = byId.get(s.sessionId);
    if (!prev || total(s) >= total(prev)) byId.set(s.sessionId, s);
  }
  return [...byId.values()];
}

/** Merge blocks that share a start time (sum their totals). */
export function dedupeBlocks(blocks: BlockEntry[]): BlockEntry[] {
  const byStart = new Map<string, BlockEntry>();
  for (const b of blocks) {
    const prev = byStart.get(b.startTime);
    if (!prev) {
      byStart.set(b.startTime, { ...b });
      continue;
    }
    prev.totalTokens += b.totalTokens;
    prev.costUSD = Number((prev.costUSD + b.costUSD).toFixed(6));
  }
  return [...byStart.values()];
}

async function runCcusageOnce(
  cmd: string,
  args: string[],
): Promise<{ json: unknown | null; transient: boolean }> {
  try {
    const { stdout } = await execFileAsync(cmd, args, {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      // A single source shouldn't be able to hang the whole run. 25s is plenty
      // for a healthy local read; a hung source gets killed and (if transient)
      // retried once below rather than stalling everything for minutes.
      timeout: 25_000,
    });
    if (!stdout) return { json: null, transient: false };
    try {
      return { json: JSON.parse(stdout), transient: false };
    } catch {
      return { json: null, transient: false };
    }
  } catch (err) {
    // execFile rejects on timeout (killed by signal), spawn failure (string
    // `code` like ENOENT), or a clean non-zero exit (numeric `code`). The first
    // two are transient (a busy machine, an OOM-killed pass) and worth one retry
    // so a source isn't silently dropped; a clean non-zero exit means the source
    // genuinely has nothing/errored — don't retry (keeps "not installed" fast).
    const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string | null };
    const transient = e.killed === true || e.signal != null || typeof e.code === "string";
    return { json: null, transient };
  }
}

async function runCcusage(cmd: string, args: string[]): Promise<unknown | null> {
  const first = await runCcusageOnce(cmd, args);
  if (first.json !== null || !first.transient) return first.json;
  // One retry on a transient failure so a flaky source stays in the report
  // run-to-run (data consistency) rather than dropping out intermittently.
  return (await runCcusageOnce(cmd, args)).json;
}

/**
 * Progress callback for the collection pipeline: invoked once per stage with the
 * number of stages completed, the total, and a short label for the stage just
 * started. Drives the CLI's loading bar; optional everywhere else.
 */
export type ProgressFn = (done: number, total: number, label: string) => void;

/** Total number of collection stages (sources + sessions/blocks/cursor/logs). */
export const COLLECT_STAGES = SOURCES.length + 4;

/** Run ccusage for every known source, add Cursor, and merge the results. */
export async function collectAll(onProgress?: ProgressFn): Promise<CollectResult> {
  const { cmd, prefixArgs } = resolveCcusageBin();
  let done = 0;
  // Each task bumps the bar as it finishes. Because everything runs at once,
  // stages complete out of order — the bar tracks the count, not the sequence.
  const tick = () => onProgress?.(++done, COLLECT_STAGES, "");

  // Everything below is independent, so fire it all off concurrently instead of
  // one source after another. The old sequential pass walked 15 `ccusage` spawns
  // (plus session/blocks/cursor/transcripts) back-to-back and dominated the wall
  // time; in parallel the run finishes in roughly the slowest single probe.
  const sourceTasks = SOURCES.map(async (source) => {
    const json = await runCcusage(cmd, [...prefixArgs, source, "daily", "--json", "--offline"]);
    tick();
    return { source, mapped: json ? mapCcusageDaily(source, json) : [] };
  });

  // Richer rollups, gathered once across all agents (ccusage aggregates them):
  // sessions power "most expensive conversations", blocks power "peak hours".
  const sessionTask = runCcusage(cmd, [...prefixArgs, "session", "--json", "--offline"]).then(
    (json) => {
      tick();
      return json ? mapCcusageSessions(json) : [];
    },
  );
  const blockTask = runCcusage(cmd, [...prefixArgs, "blocks", "--json", "--offline"]).then(
    (json) => {
      tick();
      return json ? mapCcusageBlocks(json) : [];
    },
  );
  // Cursor isn't a ccusage source — pull it from the local Cursor session +
  // dashboard API (best effort; no-op if Cursor isn't installed/signed in).
  const cursorTask = collectCursor().then((c) => {
    tick();
    return c;
  });
  // Tool/skill/project/subagent rollups from Claude Code transcripts (ccusage
  // can't see these). Async + yielding, so the loading bar keeps moving while it
  // scans. Titles + per-session message counts join onto the session rollups by
  // sessionId (ccusage's session id is the transcript uuid).
  const attributionTask = collectAttribution().then((a) => {
    tick();
    return a;
  });

  const [sourceResults, sessions, blocks, cursor, attribution] = await Promise.all([
    Promise.all(sourceTasks),
    sessionTask,
    blockTask,
    cursorTask,
    attributionTask,
  ]);

  const entries: DailyUsageEntry[] = [];
  const toolsFound: string[] = [];
  // Re-assemble in SOURCES order so the "from claude, codex, …" line stays stable.
  for (const { source, mapped } of sourceResults) {
    if (mapped.length > 0) {
      entries.push(...mapped);
      toolsFound.push(source);
    }
  }
  if (cursor.found) {
    entries.push(...cursor.entries);
    blocks.push(...cursor.blocks);
    toolsFound.push("cursor");
  }

  const { tools, skills, projects, agent, titles, sessionMessages, complete } = attribution;
  onProgress?.(COLLECT_STAGES, COLLECT_STAGES, "");

  const dedupedSessions = dedupeSessions(sessions).map((s) => {
    const title = titles.get(s.sessionId);
    const messageCount = sessionMessages.get(s.sessionId);
    return {
      ...s,
      ...(title ? { title } : {}),
      ...(messageCount ? { messageCount } : {}),
    };
  });

  return {
    // Cap each array to the server's accepted maximum (the shared SubmitPayload
    // schema: entries ≤ 20000, sessions/blocks ≤ 10000), keeping the
    // highest-token rows. Without this, a power user with >10000 distinct sessions
    // would have their ENTIRE submit rejected with a 400 instead of a capped one.
    // tools/skills/projects are already bounded upstream (attribution caps).
    entries: capByTokens(dedupeDaily(entries), 20000, entryTokens),
    sessions: capByTokens(dedupedSessions, 10000, entryTokens),
    blocks: capByTokens(dedupeBlocks(blocks), 10000, (b) => b.totalTokens),
    toolsFound,
    tools,
    skills,
    projects,
    agent,
    attributionComplete: complete,
  };
}
