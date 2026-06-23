import { z } from "zod";

/** Calendar date in YYYY-MM-DD (UTC). */
export const DateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD");

const tokenCount = z.number().int().nonnegative();

/** Provider/gateway sources a user can connect a read-only key for. */
export const ConnectorProvider = z.enum([
  "anthropic-api",
  "openai-api",
  "openrouter",
  "google-api",
  "cursor",
]);
export type ConnectorProvider = z.infer<typeof ConnectorProvider>;

/** Where a usage entry came from. "cli" is the local-log default. */
export const UsageOrigin = z.enum([
  "cli",
  "anthropic-api",
  "openai-api",
  "openrouter",
  "google-api",
  "cursor",
  "import",
]);
export type UsageOrigin = z.infer<typeof UsageOrigin>;

/**
 * One day of usage for one (tool, model) pair. This is the ONLY shape of
 * usage data that ever leaves a user's machine — aggregates, never content.
 */
export const DailyUsageEntry = z.object({
  date: DateString,
  /** Source agent id, e.g. "claude", "codex", "gemini", "copilot". */
  tool: z.string().min(1).max(64),
  /** Model id as reported by the agent, e.g. "claude-sonnet-4-6". */
  model: z.string().min(1).max(128),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  cacheReadTokens: tokenCount,
  /** Estimated cost in USD for this entry. */
  costUSD: z.number().nonnegative(),
  /** Where this entry came from. Defaults to the local CLI for back-compat. */
  origin: UsageOrigin.default("cli"),
  /** True when the numbers come from a provider's authoritative usage API. */
  verified: z.boolean().default(false),
});
export type DailyUsageEntry = z.infer<typeof DailyUsageEntry>;

/** ISO-8601 timestamp string. */
const Timestamp = z.string().min(1).max(40);

/**
 * One AI coding session (conversation), from `ccusage session`. Aggregate only:
 * a session id, the tool/model, token + cost totals, and last activity time.
 * Never any conversation content.
 */
export const SessionEntry = z.object({
  sessionId: z.string().min(1).max(128),
  tool: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  inputTokens: tokenCount,
  outputTokens: tokenCount,
  cacheCreationTokens: tokenCount,
  cacheReadTokens: tokenCount,
  costUSD: z.number().nonnegative(),
  lastActivity: Timestamp,
  /** Human-readable AI-generated session title (from transcripts). Optional. */
  title: z.string().max(200).optional(),
  /** Number of assistant messages in this session (from transcripts). Optional. */
  messageCount: z.number().int().nonnegative().optional(),
});
export type SessionEntry = z.infer<typeof SessionEntry>;

/**
 * One usage time-window, from `ccusage blocks` — used for hour-of-day ("peak
 * hours") analysis. Just a start time and its token + cost totals.
 */
export const BlockEntry = z.object({
  startTime: Timestamp,
  totalTokens: tokenCount,
  costUSD: z.number().nonnegative(),
});
export type BlockEntry = z.infer<typeof BlockEntry>;

/**
 * One tool's call frequency, parsed from local agent transcripts (e.g. Claude
 * Code `tool_use` names). MCP tools keep their `mcp__server__tool` name. Just a
 * name and a count — never any arguments or content.
 */
export const ToolStat = z.object({
  name: z.string().min(1).max(128),
  count: z.number().int().nonnegative(),
  /** How many of those calls returned an error/interrupt (tool reliability). Optional. */
  errors: z.number().int().nonnegative().optional(),
  /** Tokens burned on turns that used this tool (turn tokens split across its tool calls). Optional. */
  tokens: z.number().int().nonnegative().optional(),
});
export type ToolStat = z.infer<typeof ToolStat>;

/**
 * One project's usage, aggregated from local transcripts by working directory
 * (`cwd` basename). Just a name and token/cost totals — never paths or content.
 */
export const ProjectStat = z.object({
  name: z.string().min(1).max(128),
  tokens: z.number().int().nonnegative(),
  costUSD: z.number().nonnegative(),
});
export type ProjectStat = z.infer<typeof ProjectStat>;

/**
 * Subagent-vs-main rollup parsed from local transcripts: how much of the work
 * (messages + tokens) ran inside subagent sidechains. Counts only, no content.
 */
export const AgentStat = z.object({
  /** Total assistant messages across transcripts. */
  messageCount: z.number().int().nonnegative(),
  /** Assistant messages that ran inside a subagent sidechain. */
  subagentMessages: z.number().int().nonnegative(),
  /** Tokens spent inside subagent sidechains. */
  subagentTokens: z.number().int().nonnegative(),
  /** Total tokens observed across transcripts (denominator for the share). */
  totalTokens: z.number().int().nonnegative(),
  /**
   * Messages the human actually sent (their prompts) — non-sidechain user turns
   * carrying real text, NOT tool results or injected/meta turns. Denominator for
   * "avg cost per message". Optional (back-compat with older CLIs).
   */
  userMessageCount: z.number().int().nonnegative().optional(),
});
export type AgentStat = z.infer<typeof AgentStat>;

/** One skill's usage frequency (records produced while the skill was active). */
export const SkillStat = z.object({
  name: z.string().min(1).max(128),
  count: z.number().int().nonnegative(),
  /** Tokens burned in records produced while this skill was active. Optional. */
  tokens: z.number().int().nonnegative().optional(),
});
export type SkillStat = z.infer<typeof SkillStat>;

export const SubmitPayload = z.object({
  cliVersion: z.string().min(1).max(32),
  entries: z.array(DailyUsageEntry).min(1).max(20000),
  /** Optional per-conversation rollups (ccusage session). Back-compat: omittable. */
  sessions: z.array(SessionEntry).max(10000).optional(),
  /** Optional time-window rollups (ccusage blocks) for peak-hours analysis. */
  blocks: z.array(BlockEntry).max(10000).optional(),
  /** Optional tool-call frequencies parsed from local transcripts (names + counts). */
  tools: z.array(ToolStat).max(300).optional(),
  /** Optional skill-usage frequencies parsed from local transcripts. */
  skills: z.array(SkillStat).max(300).optional(),
  /** Optional per-project usage totals parsed from local transcripts. */
  projects: z.array(ProjectStat).max(500).optional(),
  /** Optional subagent-vs-main rollup parsed from local transcripts. */
  agent: AgentStat.optional(),
  /**
   * Set when the transcript scan completed within its time budget, i.e. the
   * tool/skill/project/agent rollups are a FULL snapshot. The server refreshes
   * the dashboard breakdowns unconditionally for a full snapshot; for a partial
   * one (flag absent/false) it keeps its no-shrink guard. Back-compat: omittable.
   */
  attributionComplete: z.boolean().optional(),
  /** Optional friends-board code (from `--board=<code>`): auto-join this board on submit. */
  board: z.string().min(1).max(32).optional(),
});
export type SubmitPayload = z.infer<typeof SubmitPayload>;

/**
 * Anonymous submit: the same usage payload plus a client-held secret key that
 * owns the resulting unlisted dashboard. No sign-in involved.
 */
export const AnonSubmitPayload = SubmitPayload.extend({
  /** Client-generated secret (hex). The server stores only its hash. */
  anonKey: z.string().min(16).max(128),
});
export type AnonSubmitPayload = z.infer<typeof AnonSubmitPayload>;

export function entryTotalTokens(e: DailyUsageEntry): number {
  return (
    e.inputTokens + e.outputTokens + e.cacheCreationTokens + e.cacheReadTokens
  );
}

export const LeaderboardPeriod = z.enum(["today", "7d", "30d", "all"]);
export type LeaderboardPeriod = z.infer<typeof LeaderboardPeriod>;

export const LeaderboardMetric = z.enum(["tokens", "cost"]);
export type LeaderboardMetric = z.infer<typeof LeaderboardMetric>;

export interface LeaderboardRow {
  rank: number;
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** X (Twitter) username without the leading @, or null. */
  xHandle: string | null;
  /** Instagram username without the leading @, when set. Optional (back-compat). */
  instagramHandle?: string | null;
  /** GitHub username, when set. Optional (back-compat). */
  githubHandle?: string | null;
  /** True once a signed-in user owns this row; false for anonymous dashboards. */
  claimed: boolean;
  totalTokens: number;
  totalCostUSD: number;
  todayTokens: number;
  streakDays: number;
  topTool: string | null;
  topModel: string | null;
  /** Last 7 days of token totals, oldest first, for sparklines. */
  spark7d: number[];
  lastSubmittedAt: string | null;
}

export interface LeaderboardResponse {
  period: LeaderboardPeriod;
  metric: LeaderboardMetric;
  tool: string | null;
  /**
   * Custom date-range window (inclusive, YYYY-MM-DD), echoed back when the caller
   * passed `from`/`to` to zoom the board into an arbitrary span instead of the
   * fixed today/7d/all buckets. When set, they override `period` for the window.
   * Optional (back-compat) — absent for the standard bucketed views.
   */
  from?: string | null;
  to?: string | null;
  generatedAt: string;
  rows: LeaderboardRow[];
}

export interface UserProfileResponse {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** X (Twitter) username without the leading @, or null. */
  xHandle: string | null;
  /** Instagram username without the leading @, when set. Optional (back-compat). */
  instagramHandle?: string | null;
  /** GitHub username, when set. Optional (back-compat). */
  githubHandle?: string | null;
  /** Short free-text bio shown on the profile. Optional (back-compat). */
  bio?: string | null;
  /** True for a signed-in (claimed) account; false for an anonymous dashboard. */
  claimed: boolean;
  /** Whether this dashboard is currently listed on the public leaderboard. */
  listed: boolean;
  /** Whether the profile page shows full detail to everyone (true) or only a
   *  minimal private card to non-owners (false). Always present. */
  profilePublic: boolean;
  createdAt: string;
  /** All-time leaderboard rank among listed users (null for anonymous/unranked). */
  rank: number | null;
  /** Rank among listed users restricted to today's burn. Optional (back-compat). */
  dailyRank?: number | null;
  /** Rank among listed users over the last 7 days. Optional (back-compat). */
  weeklyRank?: number | null;
  /** All-time rank (same value as `rank`); explicit alias. Optional (back-compat). */
  allTimeRank?: number | null;
  totals: {
    tokens: number;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
    days: number;
    streakDays: number;
    /** Longest run of consecutive active days, ever. Optional (back-compat). */
    longestStreakDays?: number;
  };
  daily: Array<{
    date: string;
    tokens: number;
    costUSD: number;
    inputTokens: number;
    outputTokens: number;
    cacheCreationTokens: number;
    cacheReadTokens: number;
  }>;
  byTool: Array<{ tool: string; tokens: number; costUSD: number }>;
  byModel: Array<{ model: string; tokens: number; costUSD: number }>;
  /** Per-project usage totals, highest first. Optional (back-compat with older API). */
  byProject?: Array<{ project: string; tokens: number; costUSD: number }>;
  /**
   * Prompt-cache efficiency: hit-rate (cache reads / reads+input) and the USD
   * saved by reads being cheaper than fresh input. Optional (back-compat).
   */
  cache?: {
    hitRate: number;
    savingsUSD: number;
    cacheReadTokens: number;
    cacheCreationTokens: number;
  };
  /** Spend pace: today so far, projected day-end, and rolling daily averages. Optional. */
  pace?: {
    todayTokens: number;
    todayCostUSD: number;
    projectedTodayCostUSD: number;
    avgDailyCostUSD: number;
    avgDailyTokens: number;
  };
  /** Subagent-vs-main rollup. `subagentShare` is the token fraction (0..1). Optional. */
  agent?: {
    messageCount: number;
    subagentMessages: number;
    subagentTokens: number;
    totalTokens: number;
    subagentShare: number;
    /** Human-sent message count (their prompts). Optional (back-compat). */
    userMessageCount?: number;
  };
  /** Total assistant messages across transcripts. Optional (back-compat). */
  messageCount?: number;
  /** Tool-call frequencies (built-in + MCP), highest first. Empty until the CLI submits them. */
  tools: ToolStat[];
  /** Skill-usage frequencies, highest first. Empty until the CLI submits them. */
  skills: SkillStat[];
  /** Most expensive conversations, highest cost first (capped). */
  topSessions: Array<{
    sessionId: string;
    tool: string;
    model: string;
    tokens: number;
    costUSD: number;
    lastActivity: string;
    /** Human-readable AI-generated title, when known. Optional (back-compat). */
    title?: string | null;
    /** Assistant message count for this session, when known. Optional. */
    messageCount?: number | null;
  }>;
  /** Token + cost by hour of day (UTC), always length 24 (index = hour). */
  hourly: Array<{ hour: number; tokens: number; costUSD: number }>;
  /** Raw day-level rows (date × tool × model) for the personal data table. */
  entries: Array<{
    date: string;
    tool: string;
    model: string;
    tokens: number;
    costUSD: number;
  }>;
  lastSubmittedAt: string | null;
}

/** One member shown on a board's roster. */
export interface BoardMember {
  handle: string;
  displayName: string;
  avatarUrl: string | null;
  /** True once a signed-in account owns this row; false for an unclaimed CLI run. */
  claimed: boolean;
  /** True if this member is the board's owner. */
  isOwner: boolean;
}

export interface BoardResponse {
  code: string;
  name: string;
  ownerHandle: string;
  memberCount: number;
  createdAt: string;
  /** Full roster, owner first. Optional (back-compat with the pre-redesign shape). */
  members?: BoardMember[];
}

/** One board in a signed-in user's "your boards" list. */
export interface BoardSummary {
  code: string;
  name: string;
  memberCount: number;
  /** "owner" if the viewer created it, else "member". */
  role: "owner" | "member";
  createdAt: string;
}

export interface MyBoardsResponse {
  boards: BoardSummary[];
}

/** Returned when a board is created (signed-in `POST /v1/boards`). */
export interface BoardCreateResponse {
  ok: true;
  code: string;
  name: string;
}

export interface DeviceCodeResponse {
  deviceCode: string;
  userCode: string;
  verifyUrl: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
}

export type DeviceTokenResponse =
  | { status: "pending" }
  | { status: "expired" }
  | { status: "ok"; token: string; handle: string };

export interface SubmitResponse {
  ok: true;
  upserted: number;
  totalTokens: number;
  totalCostUSD: number;
  rank: number | null;
  profileUrl: string;
  /** Set when a `board` code was supplied and the user joined it. */
  boardCode?: string;
  /** Full URL of the friends board, e.g. https://whoburnedmore.com/boards/<code>. */
  boardUrl?: string;
}

export interface AnonSubmitResponse {
  ok: true;
  upserted: number;
  totalTokens: number;
  totalCostUSD: number;
  /** Public, unguessable slug for the shareable dashboard URL. */
  slug: string;
  /** Full URL of the shareable dashboard, e.g. https://whoburnedmore.com/d/<slug>. */
  dashboardUrl: string;
  /** Set when a `board` code was supplied and the anon user joined it. */
  boardCode?: string;
  /** Full URL of the friends board, e.g. https://whoburnedmore.com/boards/<code>. */
  boardUrl?: string;
}

export interface ApiError {
  error: string;
  details?: string[];
}

/** One connected provider/gateway source, as shown in the profile manager. */
export interface ConnectorSummary {
  provider: ConnectorProvider;
  /** Masked key for display, e.g. "sk-…a1b2". Never the full key. */
  keyHint: string;
  status: "ok" | "error" | "pending";
  lastSyncedAt: string | null;
  lastError: string | null;
}

export interface ConnectorListResponse {
  connectors: ConnectorSummary[];
}
