/**
 * Startup and quit timeline unit tests.
 *
 * Run after `node build.mjs`.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { QuitTimeline, StartupTimeline } from '../dist/observability.js'

function clock(values) {
  let index = 0
  return () => values[Math.min(index++, values.length - 1)]
}

test('startup marks carry absolute and per-phase durations', () => {
  const timeline = new StartupTimeline(clock([100, 150, 400, 900]))
  assert.equal(timeline.mark('module').sinceStartMs, 50)
  assert.equal(timeline.mark('backend').sinceStartMs, 300)
  const last = timeline.mark('window')
  assert.equal(last.sinceStartMs, 800)
  assert.equal(last.sincePreviousMs, 500)

  const summary = timeline.summary()
  assert.equal(summary.totalMs, 800)
  assert.deepEqual(
    summary.marks.map((mark) => mark.name),
    ['module', 'backend', 'window'],
  )
})

test('startup summary is safe before any mark', () => {
  const timeline = new StartupTimeline(clock([10, 40]))
  assert.equal(timeline.summary().totalMs, 30)
  assert.deepEqual(timeline.summary().marks, [])
})

test('quit phases are timed and the slowest is reported', async () => {
  let now = 0
  const timeline = new QuitTimeline(() => now)
  await timeline.phase('preview', () => {
    now = 5
  })
  await timeline.phase('backend', async () => {
    now = 60
  })

  const summary = timeline.summary()
  assert.equal(summary.phases.length, 2)
  assert.equal(summary.phases[0].durationMs, 5)
  assert.equal(summary.phases[1].durationMs, 55)
  assert.equal(summary.slowest?.name, 'backend')
  assert.equal(summary.durationMs, 60)
})

test('a failing phase is still recorded', async () => {
  let now = 0
  const timeline = new QuitTimeline(() => now)
  await assert.rejects(
    timeline.phase('broken', () => {
      now = 7
      throw new Error('nope')
    }),
    /nope/,
  )
  assert.equal(timeline.summary().phases[0].name, 'broken')
  assert.equal(timeline.summary().phases[0].durationMs, 7)
})
