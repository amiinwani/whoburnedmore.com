import type { AnonSubmitResponse, SubmitPayload } from "./shared.js";
import { claimUrl } from "./api.js";

export interface PublishDeps {
  confirm: (question: string) => Promise<boolean>;
  ensureAnonKey: () => string;
  anonSubmit: (key: string, payload: SubmitPayload) => Promise<AnonSubmitResponse>;
  openBrowser: (url: string) => void;
  log: (line: string) => void;
}

/**
 * Offer to publish a `--local` (offline) run to the public leaderboard. On
 * accept it submits anonymously and opens the dashboard with the claim handoff;
 * on decline nothing leaves the machine. Returns whether it published.
 * Dependency-injected so the prompt/network/browser are testable.
 */
export async function publishLocal(
  payload: SubmitPayload,
  deps: PublishDeps,
): Promise<boolean> {
  if (!(await deps.confirm("  Publish this to the public leaderboard?"))) {
    deps.log("  Kept local. Nothing left your machine.");
    return false;
  }
  const key = deps.ensureAnonKey();
  const res = await deps.anonSubmit(key, payload);
  deps.log(`  Published — you're on the board: ${res.dashboardUrl}`);
  deps.openBrowser(claimUrl(res.dashboardUrl, key));
  deps.log(
    "  Sign in there to claim it, or `npx whoburnedmore private` to hide it again.",
  );
  return true;
}
