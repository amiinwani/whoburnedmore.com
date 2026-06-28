/**
 * Long-running foreground sync loop for environments with no OS scheduler —
 * containers, minimal/ephemeral VMs, CI runners, locked-down servers where
 * cron/launchd/systemd are absent or unusable. The user runs `whoburnedmore
 * daemon` under whatever keeps a process alive there (a Docker CMD, a systemd
 * service, pm2, or `nohup … &`) and it re-collects + submits on the same 15-min
 * cadence the scheduled agents use.
 *
 * The loop itself is pure and fully injectable so it can be unit-tested without
 * real timers, real network, or a real signal: the runtime in index.ts supplies
 * `runOnce` (a quiet submit), an interruptible `wait`, an `isStopped` predicate
 * wired to SIGINT/SIGTERM, and a `log` sink.
 */
export interface DaemonDeps {
  /** Do one collect+submit. Resolves on success, throws on failure. */
  runOnce: () => Promise<void>;
  /** Sleep for `ms`, resolving early if a stop has been signalled. */
  wait: (ms: number) => Promise<void>;
  /** Emit one progress/heartbeat line. */
  log: (line: string) => void;
  /** True once a stop has been requested (e.g. SIGTERM in a container). */
  isStopped: () => boolean;
  /** Milliseconds between cycles. */
  intervalMs: number;
}

/**
 * Run cycles until stop is signalled. A single failed cycle is logged and the
 * loop continues — a transient network blip or a momentarily-empty log dir must
 * never take the daemon down, the same way the scheduled agents shrug off one
 * bad tick (submits are idempotent server-side). Returns the number of cycles
 * attempted, for the shutdown line.
 */
export async function daemonLoop(deps: DaemonDeps): Promise<number> {
  let cycles = 0;
  while (!deps.isStopped()) {
    cycles++;
    try {
      await deps.runOnce();
      deps.log("synced");
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`sync failed: ${message} — retrying next cycle`);
    }
    // Check again before the long sleep so a stop arriving mid-cycle exits now
    // instead of parking for a full interval.
    if (deps.isStopped()) break;
    await deps.wait(deps.intervalMs);
  }
  return cycles;
}
