import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const cli = join(root, "dist", "index.js");

function run(args) {
  return spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      NO_COLOR: "1",
      WHOBURNEDMORE_CONFIG_DIR: join(root, ".smoke-tmp"),
    },
  });
}

function assert(condition, message, result) {
  if (condition) return;
  console.error(`package smoke failed: ${message}`);
  if (result) {
    console.error(`status: ${result.status}`);
    if (result.stdout) console.error(`stdout:\n${result.stdout}`);
    if (result.stderr) console.error(`stderr:\n${result.stderr}`);
  }
  process.exit(1);
}

const version = run(["--version"]);
assert(version.status === 0, "--version should exit 0", version);
assert(
  version.stdout.trim() === pkg.version,
  `--version should print ${pkg.version}`,
  version,
);

const help = run(["--help"]);
assert(help.status === 0, "--help should exit 0", help);
assert(
  help.stdout.includes("npx whoburnedmore link --token=TOKEN"),
  "help should advertise server linking",
  help,
);

const missingToken = run(["link"]);
assert(missingToken.status === 1, "link without --token should fail", missingToken);
assert(
  missingToken.stderr.includes("missing install token") &&
    !missingToken.stderr.includes("unknown command"),
  "link should dispatch to server-link validation, not unknown-command help",
  missingToken,
);

console.log(`package smoke passed for whoburnedmore ${pkg.version}`);
