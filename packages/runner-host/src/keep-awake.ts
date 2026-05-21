import { spawn, type ChildProcess } from "node:child_process";
import { logger } from "@cogni/shared";

/**
 * Keep the host machine reachable while the daemon is alive.
 *
 * The cloud can only delegate work to this host while its WebSocket is up, and
 * that connection dies the moment the machine sleeps. Remote clients (other
 * browsers, phone web) would then see the host as offline. So as long as the
 * daemon process is running we hold an OS-level "stay awake" assertion and
 * release it on exit.
 *
 * macOS: we shell out to `caffeinate` rather than binding IOKit natively.
 *   -i  prevent idle system sleep (works on battery + AC)
 *   -m  prevent disk idle sleep
 *   -s  prevent system sleep entirely (only honored on AC power)
 *   -w  watch our own PID — caffeinate self-terminates when the daemon dies,
 *       so a crash can't leave the machine permanently awake.
 *   We deliberately omit -d so the display can still dim/sleep normally.
 *
 * Caveat we can't beat: closing a MacBook lid forces sleep regardless of
 * caffeinate unless the machine is on AC power with an external display
 * (clamshell mode). Document this for the user; there's no software override.
 *
 * Other platforms: no-op for now (the product targets macOS hosts).
 */
let proc: ChildProcess | null = null;

export function startKeepAwake(): void {
  if (process.platform !== "darwin") {
    logger.info({ platform: process.platform }, "keep-awake: not macOS, skipping sleep prevention");
    return;
  }
  if (proc) return;

  try {
    proc = spawn("caffeinate", ["-i", "-m", "-s", "-w", String(process.pid)], {
      stdio: "ignore",
      detached: false,
    });
    proc.on("error", (err) => {
      logger.warn({ err: String(err) }, "keep-awake: failed to start caffeinate — machine may sleep");
      proc = null;
    });
    proc.on("exit", (code, signal) => {
      logger.info({ code, signal }, "keep-awake: caffeinate exited");
      proc = null;
    });
    logger.info({ pid: proc.pid }, "keep-awake: holding sleep assertion (caffeinate -i -m -s)");
  } catch (err) {
    logger.warn({ err: String(err) }, "keep-awake: could not spawn caffeinate");
    proc = null;
  }
}

export function stopKeepAwake(): void {
  if (!proc) return;
  try {
    proc.kill("SIGTERM");
  } catch {
    // already gone — caffeinate -w also self-terminates when our PID exits
  }
  proc = null;
}
