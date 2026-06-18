/**
 * whoburnedmore — a 100% local CLI that tells you how many tokens your AI coding
 * agents (Claude Code, Codex) really burned. No account, no upload, no network: it
 * reads the session transcripts already on your disk and prints a report.
 *
 *   whoburnedmore                 print the burn report
 *   whoburnedmore --by-day        per-day trend + burn rate
 *   whoburnedmore --html [file]   also write a self-contained HTML dashboard
 *   whoburnedmore --since 30      only count the last 30 days
 *   whoburnedmore --dir <path>    read Claude transcripts from a custom directory
 *   whoburnedmore --agent <name>  only count one agent (claude-code | codex)
 *   whoburnedmore --json          print the raw aggregated JSON
 *   whoburnedmore --help          show help
 *   whoburnedmore --version       print the version
 */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  defaultDataDir,
  scan,
  type Agent,
  type Bucket,
  type Report,
  type SkillBucket,
  type ToolBucket,
} from "./scan.js";
import { renderReport } from "./report.js";
import { renderHtml } from "./html.js";

// Single-sourced from package.json at build time via esbuild `define` (see build
// script); falls back to reading package.json when run unbundled (tests, ts-node).
declare const __WBM_VERSION__: string | undefined;
const VERSION =
  typeof __WBM_VERSION__ === "string" && __WBM_VERSION__ ? __WBM_VERSION__ : readPkgVersion();

function readPkgVersion(): string {
  try {
    // Resolved relative to this module; only used in the unbundled/dev path
    // (tests, ts-node). The shipped bundle gets __WBM_VERSION__ via esbuild define.
    const url = new URL("../package.json", import.meta.url);
    return JSON.parse(readFileSync(url, "utf8")).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const AGENTS: Agent[] = ["claude-code", "codex"];

export interface Args {
  help: boolean;
  version: boolean;
  json: boolean;
  html: boolean;
  byDay: boolean;
  htmlPath?: string;
  dir?: string;
  sinceDays?: number;
  agent?: Agent;
}

/** Thrown by parseArgs on invalid input; carries the user-facing message. */
export class ArgError extends Error {}

/**
 * Tiny argv parser. Recognises flags first so `--help`/`--version` never do real work.
 * Unknown flags and bad values throw {@link ArgError} (exit 2) instead of failing
 * silently — a flag you mistype should never be quietly ignored.
 */
export function parseArgs(argv: string[]): Args {
  const args: Args = { help: false, version: false, json: false, html: false, byDay: false };

  /** Consume the value that must follow a flag, or throw if it's missing. */
  const valueFor = (flag: string, i: number): { value: string; next: number } => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("-")) {
      throw new ArgError(`option '${flag}' requires a value`);
    }
    return { value: v, next: i + 1 };
  };

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--version":
      case "-v":
        args.version = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--by-day":
        args.byDay = true;
        break;
      case "--html": {
        args.html = true;
        // --html takes an OPTIONAL path; only consume a following non-flag token.
        const next = argv[i + 1];
        if (next !== undefined && !next.startsWith("-")) args.htmlPath = argv[++i];
        break;
      }
      case "--dir": {
        const { value, next } = valueFor("--dir", i);
        args.dir = value;
        i = next;
        break;
      }
      case "--since": {
        const { value, next } = valueFor("--since", i);
        const days = Number(value);
        if (!Number.isFinite(days) || days <= 0) {
          throw new ArgError(`option '--since' expects a positive number of days, got '${value}'`);
        }
        args.sinceDays = days;
        i = next;
        break;
      }
      case "--agent": {
        const { value, next } = valueFor("--agent", i);
        if (!AGENTS.includes(value as Agent)) {
          throw new ArgError(`option '--agent' expects one of ${AGENTS.join(", ")}, got '${value}'`);
        }
        args.agent = value as Agent;
        i = next;
        break;
      }
      default:
        if (a.startsWith("-")) {
          throw new ArgError(`unknown option '${a}'`);
        }
        // A bare positional argument isn't used by this CLI — treat as unknown.
        throw new ArgError(`unexpected argument '${a}'`);
    }
  }
  return args;
}

const HELP = `
  🔥 whoburnedmore — see how many tokens your AI coding agents really burned

  Usage
    whoburnedmore                  print your local burn report
    whoburnedmore --by-day         per-day trend (sparkline) + burn rate
    whoburnedmore --html [file]    also write an HTML dashboard (default: ./whoburnedmore.html)
    whoburnedmore --since <days>   only count the last N days (positive number)
    whoburnedmore --dir <path>     read Claude transcripts from a custom directory
    whoburnedmore --agent <name>   only count one agent: claude-code | codex
    whoburnedmore --json           print the raw aggregated JSON
    whoburnedmore --version, -v    print the version
    whoburnedmore --help, -h       show this help

  Reads Claude Code transcripts from ${defaultDataDir()}
  and OpenAI Codex rollouts from ~/.codex/sessions (when present).
  Days are bucketed in UTC. 100% local — no account, no upload, nothing leaves your machine.
  Hosted leaderboard: https://whoburnedmore.com
`;

/** Convert the Maps in a Report into plain objects for --json output. */
function toJSON(report: Report) {
  const obj = (m: Map<string, Bucket>) => Object.fromEntries(m);
  const tools = Object.fromEntries(report.byTool as Map<string, ToolBucket>);
  const skills = Object.fromEntries(report.bySkill as Map<string, SkillBucket>);
  const humanMessages = report.humanMessages;
  const total = report.totals.tokens;
  return {
    totals: report.totals,
    firstDate: report.firstDate,
    lastDate: report.lastDate,
    sessions: report.sessions,
    activeDays: report.byDay.size,
    humanMessages,
    avgTokensPerMessage: humanMessages > 0 ? report.totals.tokens / humanMessages : 0,
    avgCostPerMessage: humanMessages > 0 ? report.totals.costUSD / humanMessages : 0,
    subagent: {
      tokens: report.subagentTokens,
      messages: report.subagentMessages,
      sharePct: total > 0 ? (report.subagentTokens / total) * 100 : 0,
    },
    byModel: obj(report.byModel),
    byProject: obj(report.byProject),
    byAgent: Object.fromEntries(report.byAgent),
    byDay: obj(report.byDay),
    byTool: tools,
    bySkill: skills,
  };
}

export async function main(argv: string[]): Promise<number> {
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    if (err instanceof ArgError) {
      process.stderr.write(`whoburnedmore: ${err.message}\n`);
      process.stderr.write(`Run 'whoburnedmore --help' for usage.\n`);
      return 2;
    }
    throw err;
  }

  if (args.help) {
    process.stdout.write(HELP + "\n");
    return 0;
  }
  if (args.version) {
    process.stdout.write(VERSION + "\n");
    return 0;
  }

  const report = await scan({ dir: args.dir, sinceDays: args.sinceDays, agent: args.agent });

  if (args.json) {
    process.stdout.write(JSON.stringify(toJSON(report), null, 2) + "\n");
    return 0;
  }

  process.stdout.write(renderReport(report, { byDay: args.byDay }) + "\n");

  if (args.html) {
    const out = resolve(args.htmlPath ?? "whoburnedmore.html");
    writeFileSync(out, renderHtml(report), "utf8");
    process.stdout.write(`  Dashboard written to ${out}\n\n`);
  }

  return 0;
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    process.stderr.write(`whoburnedmore: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
