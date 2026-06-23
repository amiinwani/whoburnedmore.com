/** CLI argument helpers, kept separate from index.ts so they're unit-testable
 *  without triggering the CLI's top-level main() run. */

/** Parse `--board=<code>` or `--board <code>` from argv; undefined if absent. */
export function parseBoard(args: string[]): string | undefined {
  const eq = args.find((a) => a.startsWith("--board="));
  if (eq) return eq.slice("--board=".length).trim() || undefined;
  const i = args.indexOf("--board");
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
  return args.find((a) => !a.startsWith("-")) ?? "run";
}
