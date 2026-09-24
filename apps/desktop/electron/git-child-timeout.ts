/**
 * git-child-timeout.ts
 *
 * Wall-clock bound for git child processes spawned by the desktop update
 * flow. A blackholed `git ls-remote` (dead TLS connection, wedged remote,
 * hung credential helper) never closes its stdio pipes, so a promise that
 * settles only on 'close' hangs the update UI on "Looking for updates…"
 * forever (#95788). This module arms a timer that (a) reports the timeout to
 * the caller so the promise can reject and surface as a check/apply failure,
 * and (b) escalates SIGTERM → SIGKILL on the child so `git-remote-https`
 * cannot outlive the app's interest in it.
 *
 * Extracted into its own dependency-free module (no electron import) so it
 * can be unit-tested directly with a fake child, per the same convention as
 * windows-child-options.ts.
 */

/**
 * Conservative default bound for a single git operation. Every runGit call in
 * the update flow is a probe or short metadata read (`ls-remote`,
 * `rev-parse`, `remote get-url`, `cat-file`, `merge-base`) that answers in
 * well under a second on any healthy network; 60s covers a slow first-fetch
 * warm-up while still being short enough that a wedged connection fails
 * within one attention span instead of never.
 */
export const GIT_OPERATION_TIMEOUT_MS = 60_000

/**
 * Grace period between SIGTERM and SIGKILL. git exits promptly on SIGTERM
 * when it is merely waiting on a socket; the hard kill only exists for a
 * child wedged somewhere unresponsive.
 */
export const GIT_TERMINATE_GRACE_MS = 5_000

/** Error kind stamped on a runGit rejection caused by the wall-clock bound. */
export const GIT_TIMEOUT = 'git-timeout'

export interface GitTimeoutHandle {
  /** Call when the child settles (close/error) so no late timer fires. */
  cancel(): void
  /** True once the wall-clock bound elapsed and the child was signalled. */
  timedOut(): boolean
}

/** Signal sent to a wedged git child; SIGKILL after the grace period. */
export type TimeoutSignal = 'SIGTERM' | 'SIGKILL'

/**
 * Minimal structural type for the child process we bound — the spawn() result
 * satisfies it, and tests can pass any object with a matching kill().
 */
export interface GitTimeoutChild {
  kill(signal?: NodeJS.Signals | number): boolean
}

/**
 * Arm the wall-clock bound for a git child. `onTimeout` fires first (the
 * caller rejects its promise — resolve calls after that are no-ops), then the
 * child is asked to terminate: SIGTERM immediately, SIGKILL after
 * `graceMs` unless `cancel()` runs (the SIGTERM worked and 'close' fired).
 *
 * On Windows `SIGTERM` maps to a hard TerminateProcess, which is what a
 * wedged git needs there; the escalation is harmless redundancy.
 *
 * @param child - the spawned git process (or any { kill }-shaped object in tests).
 * @param onTimeout - invoked exactly once when the bound elapses, before any signal.
 * @param timeoutMs - wall-clock bound; defaults to GIT_OPERATION_TIMEOUT_MS.
 * @param graceMs - SIGTERM → SIGKILL escalation window.
 */
export function armGitTimeout(
  child: GitTimeoutChild,
  onTimeout: () => void,
  timeoutMs: number = GIT_OPERATION_TIMEOUT_MS,
  graceMs: number = GIT_TERMINATE_GRACE_MS
): GitTimeoutHandle {
  let elapsed = false
  let killTimer: ReturnType<typeof setTimeout> | undefined

  const signal = (sig: TimeoutSignal) => {
    try {
      child.kill(sig)
    } catch {
      // Already-dead children throw on kill in some Node versions; the
      // promise already settled via 'close'/'error' in that case.
    }
  }

  const timer = setTimeout(() => {
    elapsed = true
    onTimeout()
    signal('SIGTERM')
    killTimer = setTimeout(() => signal('SIGKILL'), graceMs)
    killTimer.unref?.()
  }, timeoutMs)

  timer.unref?.()

  return {
    cancel() {
      clearTimeout(timer)

      if (killTimer !== undefined) {
        clearTimeout(killTimer)
      }
    },
    timedOut() {
      return elapsed
    }
  }
}
