# Contributing to whoburnedmore

Thanks for taking the time to contribute! This is a small, friendly project and PRs are welcome.

## Development

You'll need Node.js 20+.

```bash
npm install        # install dependencies and build
npm test           # run the unit tests (node:test)
npm run typecheck  # strict TypeScript check
npm run build      # bundle to dist/cli.js
npm start          # run the CLI locally
```

## Ground rules

- **Keep it local.** This tool's whole promise is that nothing leaves your machine. Pull requests that add network calls, telemetry, analytics, or "phone home" behaviour will not be merged.
- **Keep it small.** Prefer the standard library over new dependencies. There are currently zero runtime dependencies — let's keep it that way where we can.
- **Add a test.** New aggregation or pricing logic should come with a test in [`test/`](./test).
- **Match the style.** Run `npm run typecheck` before opening a PR; keep functions small and commented.

## Good first issues

- Add or correct models in the [pricing table](./src/pricing.ts).
- Support transcript formats from more AI coding agents. **Claude Code** and **OpenAI Codex** are supported today; **Cursor** is a future addition that would need an optional external tool to read its store.
- Improve the HTML dashboard layout or add a chart.
- ~~Add a `--by-day` sparkline to the terminal report.~~ ✅ Done in 1.1.0.

## Reporting bugs

Open an issue with your Node version, OS, and the exact command you ran. Never paste real prompt content or anything sensitive — `--json` output with the numbers is plenty.
