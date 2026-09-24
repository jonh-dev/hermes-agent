import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'

import { test, vi } from 'vitest'

import {
  armGitTimeout,
  GIT_OPERATION_TIMEOUT_MS,
  GIT_TERMINATE_GRACE_MS
} from './git-child-timeout'

function fakeChild() {
  const calls: string[] = []

  return {
    calls,
    kill: (sig?: NodeJS.Signals | number): boolean => {
      calls.push(String(sig))

      return true
    }
  }
}

test('timeout fires onTimeout once, then SIGTERM and SIGKILL after the grace period', () => {
  vi.useFakeTimers()

  try {
    const child = fakeChild()
    let fired = 0
    const handle = armGitTimeout(child, () => { fired += 1 }, 1000, 250)

    vi.advanceTimersByTime(999)
    assert.equal(fired, 0)
    assert.deepEqual(child.calls, [])

    vi.advanceTimersByTime(1)
    assert.equal(fired, 1)
    assert.deepEqual(child.calls, ['SIGTERM'])
    assert.equal(handle.timedOut(), true)

    vi.advanceTimersByTime(249)
    assert.deepEqual(child.calls, ['SIGTERM'])

    vi.advanceTimersByTime(1)
    assert.deepEqual(child.calls, ['SIGTERM', 'SIGKILL'])
    // The escalation fired, but onTimeout still ran exactly once.
    assert.equal(fired, 1)
  } finally {
    vi.useRealTimers()
  }
})

test('cancel before the bound keeps the child alive and never calls onTimeout', () => {
  vi.useFakeTimers()

  try {
    const child = fakeChild()
    let fired = 0
    const handle = armGitTimeout(child, () => { fired += 1 }, 1000, 250)

    handle.cancel()
    vi.advanceTimersByTime(10_000)

    assert.equal(fired, 0)
    assert.deepEqual(child.calls, [])
    assert.equal(handle.timedOut(), false)
  } finally {
    vi.useRealTimers()
  }
})

test('cancel between SIGTERM and SIGKILL stops the escalation (SIGTERM worked, close fired)', () => {
  vi.useFakeTimers()

  try {
    const child = fakeChild()
    const handle = armGitTimeout(child, () => {}, 1000, 250)

    vi.advanceTimersByTime(1000)
    assert.deepEqual(child.calls, ['SIGTERM'])

    // The SIGTERM succeeded and the caller observed 'close'.
    handle.cancel()
    vi.advanceTimersByTime(10_000)

    assert.deepEqual(child.calls, ['SIGTERM'])
  } finally {
    vi.useRealTimers()
  }
})

test('a kill() that throws (already-dead child) does not break the escalation', () => {
  vi.useFakeTimers()

  try {
    let fired = 0

    const child = {
      kill: () => { throw new Error('child already dead') }
    }

    const handle = armGitTimeout(child, () => { fired += 1 }, 1000, 250)

    vi.advanceTimersByTime(1250)
    assert.equal(fired, 1)
    assert.equal(handle.timedOut(), true)
  } finally {
    vi.useRealTimers()
  }
})

test('a real wedged child is terminated within the bound', async () => {
  // Simulates the #95788 blackhole: a process that never exits on its own
  // and never closes stdio (an infinite loop with open pipes, standing in
  // for git-remote-https stuck on a dead TLS connection).
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    stdio: ['ignore', 'pipe', 'pipe']
  })

  let timedOut = false

  const exited = new Promise<void>(resolve => {
    const handle = armGitTimeout(
      child,
      () => { timedOut = true },
      500,
      300
    )

    child.once('close', () => {
      handle.cancel()
      resolve()
    })
  })

  // Generous wall-clock margin for CI: the bound is 500ms + at most 300ms of
  // escalation, so 10s means "the kill path genuinely failed".
  await Promise.race([exited, new Promise((_, reject) =>
    setTimeout(() => reject(new Error('child was not killed within 10s')), 10_000)
  )])

  assert.equal(timedOut, true)
  assert.equal(child.exitCode, null)
  assert.ok(child.killed, 'the child died from our signal, not on its own')
})

test('default constants are conservative: 60s bound, short escalation grace', async () => {
  // Relationship contract, not a snapshot: the bound must stay generous
  // enough for a slow-but-alive git probe while the escalation must be
  // brief enough that a wedged child is reaped promptly.
  assert.equal(GIT_OPERATION_TIMEOUT_MS, 60_000)
  assert.ok(GIT_TERMINATE_GRACE_MS > 0 && GIT_TERMINATE_GRACE_MS <= 15_000)
})
