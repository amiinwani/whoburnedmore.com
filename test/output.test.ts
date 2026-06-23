import { describe, it, expect } from "vitest";
import { submitNextStepLines } from "../src/output.js";

describe("submitNextStepLines (core online command — no usage numbers)", () => {
  it("returns the dashboard URL + a sign-in/X next step, with no burn numbers", () => {
    const lines = submitNextStepLines({
      dashboardUrl: "https://whoburnedmore.com/d/cool-slug-7",
    });
    const text = lines.join("\n");
    expect(text).toContain("https://whoburnedmore.com/d/cool-slug-7");
    expect(text.toLowerCase()).toContain("sign in");
    expect(text).toMatch(/\bX\b/);
    // Crucially: NO burn report / token totals / costs leak into the terminal on
    // the core online command — the web dashboard is where usage is reviewed.
    // (Note "whoburnedmore" legitimately contains "burned" — assert on the actual
    // burn-report markers instead: a token count or a $ cost figure.)
    expect(text.toLowerCase()).not.toContain("tokens");
    expect(text.toLowerCase()).not.toContain("burn report");
    expect(text).not.toMatch(/\$\s*\d/);
    expect(text).not.toMatch(/\d[\d.,]*\s*[BMK]\b/);
  });

  it("points to the board and hands over the exact command to invite a friend", () => {
    const lines = submitNextStepLines({
      dashboardUrl: "https://whoburnedmore.com/d/x",
      boardUrl: "https://whoburnedmore.com/boards/ABC123",
      boardCode: "ABC123",
    });
    const text = lines.join("\n");
    expect(text).toContain("/boards/ABC123");
    // The obvious "get a friend on it" share command is present, with the code.
    expect(text).toContain("npx whoburnedmore --board=ABC123");
    expect(text.toLowerCase()).toContain("sign in");
    expect(text).toMatch(/\bX\b/);
    expect(text.toLowerCase()).not.toContain("tokens");
  });

  it("derives the invite command's code from the board URL when not passed", () => {
    const lines = submitNextStepLines({
      dashboardUrl: "https://whoburnedmore.com/d/x",
      boardUrl: "https://whoburnedmore.com/boards/deadbeef99",
    });
    expect(lines.join("\n")).toContain("npx whoburnedmore --board=deadbeef99");
  });
});
