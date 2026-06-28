import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(join(here, "..", "package.json"), "utf8"),
) as {
  scripts?: Record<string, string>;
};

describe("npm publish guardrails", () => {
  it("runs the real package smoke check during prepublish", () => {
    expect(pkg.scripts?.["smoke:package"]).toBe(
      "node scripts/smoke-package.mjs",
    );
    const prepublish = pkg.scripts?.prepublishOnly ?? "";
    expect(prepublish).toContain("run lint");
    expect(prepublish).toContain("run test");
    expect(prepublish).toContain("run build");
    expect(prepublish).toContain("run smoke:package");
  });
});
