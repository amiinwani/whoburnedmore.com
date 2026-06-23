# whoburnedmore

> Find out who burned more — submit your AI coding-agent token usage to the public
> leaderboard at [whoburnedmore.com](https://whoburnedmore.com).

```bash
npx whoburnedmore
```

**This is the real, production CLI** — the exact code published to npm and run on users'
machines. This repository is a public, always-in-sync mirror of it.

## What it does

`whoburnedmore` reads your local AI coding-agent usage (Claude Code, Codex, Gemini CLI,
Copilot, Cursor and more, via [ccusage](https://github.com/ryoppippi/ccusage)), adds up
the tokens and estimated cost, and **submits your daily totals to the whoburnedmore.com
server** so you land on the public leaderboard and get a shareable dashboard.

### What leaves your machine

Only **daily aggregate numbers** — date, tool, model, token counts, and estimated cost
(plus optional per-session / per-tool rollups). **Never** your prompts, your code, file
contents, or file paths. Sign in on the website to claim your dashboard; run
`private`/`remove` to pull it, or use `--local` to stay fully offline.

> Want a 100%-local report that makes **no** network calls at all? Use `npx whoburnedmore
> --local`, which builds an HTML dashboard on your machine and uploads nothing.

## Commands

```
npx whoburnedmore              submit + land on the leaderboard, open your dashboard
npx whoburnedmore --local      build the dashboard locally and open it (offline, no upload)
npx whoburnedmore --dry-run    print exactly what would be sent, send nothing
npx whoburnedmore --no-submit  collect locally, send nothing
npx whoburnedmore private      hide your dashboard from the leaderboard
npx whoburnedmore public       put it back
npx whoburnedmore remove       delete your dashboard and its data
npx whoburnedmore status       check background-sync health
npx whoburnedmore uninstall-sync   turn off the background sync
```

After your first run, a background sync keeps your page fresh automatically
(`uninstall-sync` to stop). The server endpoint is overridable with `WHOBURNEDMORE_API`.

## Privacy & transparency

This repository exists so you can read exactly what the CLI does before you run it. It
contains no secrets and no server code — just the client that talks to the public API.

## Build

```bash
npm install
npm run build   # bundles src/index.ts -> dist/index.js
npm test
```

## License

MIT
