import { describe, expect, it } from "vitest";
import { parseBoard, resolveCommand } from "../src/args.js";

describe("parseBoard", () => {
  it("reads --board=<code>", () => {
    expect(parseBoard(["--board=abc123"])).toBe("abc123");
  });

  it("reads --board <code> (space form)", () => {
    expect(parseBoard(["--board", "deadbeef"])).toBe("deadbeef");
  });

  it("is undefined when absent", () => {
    expect(parseBoard(["--dry-run"])).toBeUndefined();
    expect(parseBoard([])).toBeUndefined();
  });

  it("ignores an empty value and a following flag", () => {
    expect(parseBoard(["--board="])).toBeUndefined();
    expect(parseBoard(["--board", "--local"])).toBeUndefined();
  });

  it("coexists with other flags in any order", () => {
    expect(parseBoard(["--dry-run", "--board=lab7", "--no-submit"])).toBe("lab7");
  });
});

describe("resolveCommand", () => {
  it("defaults to run with no args", () => {
    expect(resolveCommand([])).toBe("run");
  });

  it("treats lone non-command flags as a run (with those flags applied elsewhere)", () => {
    expect(resolveCommand(["--dry-run"])).toBe("run");
    expect(resolveCommand(["--local"])).toBe("run");
    expect(resolveCommand(["--board=abc"])).toBe("run");
  });

  it("maps --help and -h to help — never a silent run/submit", () => {
    // Regression: --help/-h start with '-', so the old first-non-dash-arg
    // resolution fell through to "run" and PUBLICLY SUBMITTED the user's usage.
    expect(resolveCommand(["--help"])).toBe("help");
    expect(resolveCommand(["-h"])).toBe("help");
    expect(resolveCommand(["help"])).toBe("help");
  });

  it("maps --version and -v to version", () => {
    expect(resolveCommand(["--version"])).toBe("version");
    expect(resolveCommand(["-v"])).toBe("version");
    expect(resolveCommand(["version"])).toBe("version");
  });

  it("help wins even alongside other flags or subcommands", () => {
    expect(resolveCommand(["private", "--help"])).toBe("help");
    expect(resolveCommand(["--dry-run", "-h"])).toBe("help");
  });

  it("returns an explicit subcommand verbatim (so unknowns still error in main)", () => {
    expect(resolveCommand(["private"])).toBe("private");
    expect(resolveCommand(["sync"])).toBe("sync");
    expect(resolveCommand(["remove"])).toBe("remove");
    expect(resolveCommand(["bogus"])).toBe("bogus");
  });
});
