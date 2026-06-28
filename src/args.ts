/** CLI argument helpers, kept separate from index.ts so they're unit-testable
 *  without triggering the CLI's top-level main() run. */

/** Parse `--board=<code>` or `--board <code>` from argv; undefined if absent. */
export function parseBoard(args: string[]): string | undefined {
  return parseValueFlag(args, "--board");
}

/** Parse `--org=<slug>` or `--org <slug>` from argv; undefined if absent. */
export function parseOrg(args: string[]): string | undefined {
  return parseValueFlag(args, "--org");
}

/**
 * Parse the org join password from `--pass=<code>` / `--pass <code>` (or its
 * `--code` alias); undefined if absent. Required to attach a run to an `--org`.
 */
export function parsePass(args: string[]): string | undefined {
  return parseValueFlag(args, "--pass") ?? parseValueFlag(args, "--code");
}

/** Parse `--token=<install-token>` or `--token <install-token>` for server linking. */
export function parseInstallToken(args: string[]): string | undefined {
  return parseValueFlag(args, "--token");
}

/** The optional board/org scope a run can submit into. */
export interface ScopeFlags {
  board?: string;
  org?: string;
  /** Org join password — only meaningful alongside `org`. */
  orgCode?: string;
}

/**
 * Attach the optional `board`/`org` scope to a submit payload, only when set —
 * so a plain run produces a payload with NEITHER key (back-compat). Pure and
 * unit-testable; used by run() in index.ts.
 */
export function applyScope<T extends Record<string, unknown>>(
  payload: T,
  flags: ScopeFlags,
): T {
  if (flags.board) (payload as Record<string, unknown>).board = flags.board;
  if (flags.org) (payload as Record<string, unknown>).org = flags.org;
  if (flags.org && flags.orgCode)
    (payload as Record<string, unknown>).orgCode = flags.orgCode;
  return payload;
}

/** Shared `--name=value` / `--name value` reader; ignores empty and following flags. */
function parseValueFlag(args: string[], name: string): string | undefined {
  const prefix = `${name}=`;
  const eq = args.find((a) => a.startsWith(prefix));
  if (eq) return eq.slice(prefix.length).trim() || undefined;
  const i = args.indexOf(name);
  if (i !== -1 && args[i + 1] && !args[i + 1].startsWith("-")) {
    return args[i + 1].trim() || undefined;
  }
  return undefined;
}

/**
 * Resolve which command the CLI should dispatch from argv.
 *
 * Help/version are checked FIRST, including their flag spellings (`--help`,
 * `-h`, `--version`, `-v`). They start with "-", so the old "first non-dash arg
 * else run" logic never matched them and `whoburnedmore --help` fell through to
 * a real `run` — silently collecting and PUBLICLY submitting the user's usage.
 * Recognising the flags here keeps `--help`/`-h` informational and side-effect
 * free. After that, an explicit subcommand wins; otherwise the default is `run`.
 * Unknown words are returned verbatim so main() can report "unknown command".
 */
export function resolveCommand(args: string[]): string {
  if (args.includes("--help") || args.includes("-h") || args.includes("help")) {
    return "help";
  }
  if (
    args.includes("--version") ||
    args.includes("-v") ||
    args.includes("version")
  ) {
    return "version";
  }
  // Skip the value token that follows a value-flag (`--board CODE`, `--org SLUG`)
  // so the space form isn't mistaken for a subcommand.
  const valueFlags = new Set(["--board", "--org", "--token", "--pass", "--code"]);
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("-")) {
      if (valueFlags.has(a)) i++; // also skip its value
      continue;
    }
    return a;
  }
  return "run";
}
