# Changelog

All notable changes to **whoburnedmore** (the open-source, 100% local edition).
This project adheres to [Semantic Versioning](https://semver.org).

## 1.1.0

First tagged release. Adds multi-agent support and richer local attribution while
keeping the same promise: zero network, zero runtime dependencies, nothing leaves
your machine.

### Added
- **Multi-agent: OpenAI Codex support.** Reads local Codex session rollouts from
  `~/.codex/sessions` (when present) and folds them into the same report, tagged with
  an `agent` dimension. A new **By agent** rollup appears in the report, the HTML
  dashboard, and `--json` when more than one agent contributed.
- **`--agent <name>` filter** — limit the report to `claude-code` or `codex`.
- **`--by-day` trend view** — a compact per-day sparkline of tokens and estimated
  cost (last 14 active days, or all within `--since`), plus a **burn-rate** line
  (avg tokens/day and $/day over the window). Days are bucketed in UTC.
- **Transcript attribution.** New **By tool** section (call count, error rate, tokens —
  errors matched from `is_error` tool results back to their tool call), a **subagent
  share** (sidechain tokens as a % of total), **human-message** counting (real typed
  turns only, excluding tool results, slash-command expansions, injected reminders and
  meta records) used for **avg tokens / cost per message**, and an optional **By skill**
  section when transcripts carry skill attribution. All of these are also in `--json`.
- **Pricing transparency.** Exported `PRICING_AS_OF` constant, surfaced as a
  "prices as of <date> · list-price estimate" note in the report and HTML.
- **More models in the pricing table** — `gpt-5*`, `o1`/`o3`/`o4`, and the Gemini
  1.5 / 2.0 / 2.5 / 3 families — so fewer models hit the generic fallback.
- **Committed zero-network guard test** that scans `src/` and the built `dist/cli.js`
  and fails if any networking primitive (`fetch(`, `http(s)://`, `node:net/tls/dgram`,
  `WebSocket`, `XMLHttpRequest`) appears — the one exception being the visible
  leaderboard link in display copy.
- **Release workflow** — pushing a `v*` tag runs the full gate and cuts a GitHub
  Release with the built bundle (no npm publish).

### Changed
- **Strict input validation.** Unknown flags and a non-positive / non-numeric
  `--since` (including `--since 0` and negatives) now print an error and exit `2`
  instead of being silently ignored. Value-taking flags error when given no value.
- **Pricing table** — collapsed the redundant `claude-3-5-sonnet` / `claude-3-5-haiku`
  rows into tier-word family rows (`opus` / `sonnet` / `haiku`) that also resolve the
  older dated ids, so there are no duplicate rows and nothing regresses to the default.
- **Version is single-sourced** from `package.json` (injected at build time), so
  `--version` and the package can never drift.

## 1.0.0

Initial open-source release: a 100% local CLI that reads Claude Code transcripts and
prints a token/cost burn report, with `--html`, `--since`, `--dir`, and `--json`.
