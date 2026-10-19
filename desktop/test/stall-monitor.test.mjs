/**
 * Unit tests for the simplified main-event-loop stall monitor.
 *
 * Run after `node build.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { StallMonitor } from '../dist/stall-monitor.js'

test('on-time ticks produce no sample', () => {
  let mono = 0
  let wall = 1_000_000
  const monitor = new StallMonitor({
    intervalMs: 200,
    thresholdMs: 1000,
    now: () => mono,
    wall: () => wall,
  })
  mono = 200
  wall += 200
  assert.equal(monitor.tick(), null)
  mono = 400
  wall += 200
  assert.equal(monitor.tick(), null)
})

test('a blocked main thread reports the overrun', () => {
  let mono = 0
  let wall = 1_000_000
  const monitor = new StallMonitor({
    intervalMs: 200,
    thresholdMs: 1000,
    now: () => mono,
    wall: () => wall,
  })
  mono = 2500
  wall += 2500
  const sample = monitor.tick()
  assert.ok(sample)
  assert.equal(sample.durationMs, 2300)
  assert.equal(sample.suspended, false)
})

test('a wall-clock jump is treated as suspend, not a stall', () => {
  let mono = 0
  let wall = 1_000_000
  const monitor = new StallMonitor({
    intervalMs: 200,
    thresholdMs: 1000,
    now: () => mono,
    wall: () => wall,
  })
  mono = 3000
  wall += 60_000
  const sample = monitor.tick()
  assert.ok(sample)
  assert.equal(sample.suspended, true)
  assert.ok(sample.wallJumpMs >= 57_000)
})

test('clamps tiny intervals and thresholds', () => {
  let mono = 0
  const monitor = new StallMonitor({
    intervalMs: 1,
    thresholdMs: 1,
    now: () => mono,
    wall: () => 0,
  })
  mono = 400
  const sample = monitor.tick()
  assert.ok(sample)
  assert.ok(sample.durationMs > 250)
})
