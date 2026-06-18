/** Renders an aggregated {@link Report} as a colourful terminal "burn report". */
import type { Report, ToolBucket } from "./scan.js";
import { PRICING_AS_OF } from "./pricing.js";
import { bar, formatTokens, formatUSD, sparkline, topBy, topByTokens } from "./format.js";

// Minimal ANSI styling — no dependency, and it auto-disables when output isn't a TTY
// or when NO_COLOR is set (see the no-color.org convention).
const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  orange: wrap("38;5;208"),
  green: wrap("38;5;42"),
  dim: wrap("2"),
  bold: wrap("1"),
  cyan: wrap("36"),
};

const RULE = "─".repeat(48);

export interface ReportOptions {
  /** Show the per-day trend section + burn rate. */
  byDay?: boolean;
  /** How many days to show in the --by-day view (default 14). */
  byDayLimit?: number;
}

export function renderReport(report: Report, opts: ReportOptions = {}): string {
  const { totals } = report;
  const lines: string[] = [];
  const push = (s = "") => lines.push(s);

  push();
  push(`  ${c.orange("🔥 whoburnedmore")} ${c.dim("— your local AI token burn report")}`);
  push(`  ${c.dim(RULE)}`);

  if (totals.tokens === 0) {
    push();
    push(`  ${c.dim("No Claude Code or Codex usage found yet.")}`);
    push(`  ${c.dim("Use an AI coding agent for a bit, then run this again.")}`);
    push();
    return lines.join("\n");
  }

  const span =
    report.firstDate && report.lastDate
      ? `${report.firstDate} → ${report.lastDate}`
      : "all time";

  push();
  push(`  ${c.bold(c.green(formatTokens(totals.tokens)))} ${c.dim("tokens burned")}   ${c.bold(formatUSD(totals.costUSD))} ${c.dim("est.")}`);
  push(`  ${c.dim(`${totals.messages.toLocaleString()} assistant turns · ${report.byDay.size} active days · ${span}`)}`);

  // Per-human-message averages (real typed turns are the honest denominator).
  if (report.humanMessages > 0) {
    const avgTokens = totals.tokens / report.humanMessages;
    const avgCost = totals.costUSD / report.humanMessages;
    push(
      `  ${c.dim(`${report.humanMessages.toLocaleString()} human messages · ${formatTokens(avgTokens)} tokens / msg · ${formatUSD(avgCost)} / msg`)}`,
    );
  }

  // Per-agent rollup (only interesting when more than one agent contributed).
  if (report.byAgent.size > 1) {
    push();
    push(`  ${c.bold("By agent")}`);
    for (const [agent, b] of topByTokens(report.byAgent as Map<string, typeof totals>)) {
      const frac = b.tokens / totals.tokens;
      push(
        `    ${c.cyan(bar(frac, 18))} ${agent.padEnd(26)} ${formatTokens(b.tokens).padStart(8)}  ${c.dim(formatUSD(b.costUSD).padStart(11))}`,
      );
    }
  }

  // Per-model breakdown
  push();
  push(`  ${c.bold("By model")}`);
  for (const [model, b] of topBy(report.byModel)) {
    const frac = b.tokens / totals.tokens;
    push(
      `    ${c.green(bar(frac, 18))} ${model.padEnd(26)} ${formatTokens(b.tokens).padStart(8)}  ${c.dim(formatUSD(b.costUSD).padStart(11))}`,
    );
  }

  // Per-project breakdown
  push();
  push(`  ${c.bold("By project")}`);
  for (const [project, b] of topBy(report.byProject)) {
    const frac = b.tokens / totals.tokens;
    push(
      `    ${c.orange(bar(frac, 18))} ${project.slice(0, 26).padEnd(26)} ${formatTokens(b.tokens).padStart(8)}  ${c.dim(formatUSD(b.costUSD).padStart(11))}`,
    );
  }

  // Per-tool breakdown (top 8 by tokens), with call count + error rate.
  if (report.byTool.size > 0) {
    push();
    push(`  ${c.bold("By tool")}`);
    for (const [name, t] of topByTokens(report.byTool as Map<string, ToolBucket>)) {
      const errPct = t.count > 0 ? (t.errors / t.count) * 100 : 0;
      push(
        `    ${name.slice(0, 18).padEnd(18)} ${String(t.count).padStart(6)} calls  ${c.dim(`${errPct.toFixed(1)}% err`)}  ${formatTokens(t.tokens).padStart(8)}`,
      );
    }
  }

  // Optional per-skill breakdown (present only if transcripts carry the field).
  if (report.bySkill.size > 0) {
    push();
    push(`  ${c.bold("By skill")}`);
    for (const [name, s] of topByTokens(report.bySkill)) {
      push(
        `    ${name.slice(0, 24).padEnd(24)} ${String(s.count).padStart(6)} uses  ${formatTokens(s.tokens).padStart(8)}`,
      );
    }
  }

  // Subagent share.
  if (report.subagentTokens > 0) {
    const pct = (report.subagentTokens / totals.tokens) * 100;
    push();
    push(
      `  ${c.bold("Subagents")}   ${c.green(`${pct.toFixed(1)}%`)} ${c.dim("of tokens")} ${c.dim(`(${report.subagentMessages.toLocaleString()} sidechain turns)`)}`,
    );
  }

  // Cache efficiency — a fun, genuinely useful stat
  const cacheable = totals.cacheRead + totals.input;
  if (cacheable > 0) {
    const hitRate = (totals.cacheRead / cacheable) * 100;
    push();
    push(`  ${c.bold("Prompt cache")}   ${c.green(`${hitRate.toFixed(1)}%`)} ${c.dim("read-hit rate")} ${c.dim(`(${formatTokens(totals.cacheRead)} cached reads)`)}`);
  }

  // Per-day trend (opt-in via --by-day).
  if (opts.byDay) {
    renderByDay(report, opts.byDayLimit ?? 14, push, c);
  }

  push();
  push(`  ${c.dim(RULE)}`);
  push(`  ${c.dim(`Prices as of ${PRICING_AS_OF} · list-price estimate, not a bill.`)}`);
  push(`  ${c.dim("100% local · nothing left your machine.")}`);
  push(`  ${c.dim("Compare on the public board →")} ${c.cyan("https://whoburnedmore.com")}`);
  push();

  return lines.join("\n");
}

/** Render the compact per-day trend + a burn-rate line. */
function renderByDay(
  report: Report,
  limit: number,
  push: (s?: string) => void,
  col: typeof c,
): void {
  const days = [...report.byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  if (days.length === 0) return;
  const shown = days.slice(-limit);
  const maxTokens = Math.max(...shown.map(([, b]) => b.tokens), 1);

  push();
  push(`  ${col.bold("By day")} ${col.dim("(UTC days)")}`);
  for (const [day, b] of shown) {
    const spark = sparkline(b.tokens / maxTokens, 16);
    push(
      `    ${col.dim(day)}  ${col.orange(spark)} ${formatTokens(b.tokens).padStart(8)}  ${col.dim(formatUSD(b.costUSD).padStart(11))}`,
    );
  }

  // Burn rate over the active window (only the days that actually had usage).
  const windowDays = shown.length;
  const sumTokens = shown.reduce((n, [, b]) => n + b.tokens, 0);
  const sumCost = shown.reduce((n, [, b]) => n + b.costUSD, 0);
  push();
  push(
    `  ${col.bold("Burn rate")}   ${formatTokens(sumTokens / windowDays)} ${col.dim("tokens/day")} · ${formatUSD(sumCost / windowDays)} ${col.dim("/day")} ${col.dim(`(over ${windowDays} active days)`)}`,
  );
}
