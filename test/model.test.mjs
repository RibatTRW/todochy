// Unit tests for Model.js — the rules that decide cadence, streaks and state.
//
// Run with:  node --test test/
//
// These are plain node tests with no QML runtime: Model.js is written as a
// CommonJS-compatible module precisely so the rules with real consequences
// (a streak resetting, a long break landing on the wrong block, a corrupt
// state file) are checkable without a shell restart.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const Model = require("../Model.js")

// Local noon avoids any timezone edge at the day boundary.
const DAY = 24 * 60 * 60 * 1000
function noon(y, m, d) {
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime()
}

test("formatMs renders MM:SS below an hour and H:MM:SS above", () => {
  assert.equal(Model.formatMs(0), "00:00")
  assert.equal(Model.formatMs(59 * 1000), "00:59")
  assert.equal(Model.formatMs(25 * 60 * 1000), "25:00")
  assert.equal(Model.formatMs(60 * 60 * 1000), "1:00:00")
  assert.equal(Model.formatMs(-5000), "00:00")
})

test("defaults are the captain's 25/5/15/4 ratio", () => {
  const s = Model.normalizeSettings({})
  assert.deepEqual(s, {
    workMinutes: 25,
    shortBreakMinutes: 5,
    longBreakMinutes: 15,
    longBreakEvery: 4
  })
})

test("missing or garbage settings fall back instead of poisoning the timer", () => {
  const s = Model.normalizeSettings({
    workMinutes: "abc",
    shortBreakMinutes: 0,
    longBreakMinutes: 99999,
    longBreakEvery: -3
  })
  assert.equal(s.workMinutes, 25)
  assert.equal(s.shortBreakMinutes, 1)
  assert.equal(s.longBreakMinutes, 600)
  assert.equal(s.longBreakEvery, 1)
})

test("a long break lands on every Nth completed work block", () => {
  const every = 4
  const phases = []
  for (let blocks = 1; blocks <= 8; blocks++) phases.push(Model.nextPhaseAfterWork(blocks, every))
  assert.deepEqual(phases, ["short", "short", "short", "long", "short", "short", "short", "long"])
})

test("cycle position counts 1..N and wraps after the long break", () => {
  assert.equal(Model.cyclePosition(0, 4), 1)
  assert.equal(Model.cyclePosition(1, 4), 2)
  assert.equal(Model.cyclePosition(3, 4), 4)
  assert.equal(Model.cyclePosition(4, 4), 1)
  assert.equal(Model.cyclePosition(5, 4), 2)
})

test("progressFraction clamps and tolerates a zero-length phase", () => {
  assert.equal(Model.progressFraction(1500, 3000), 0.5)
  assert.equal(Model.progressFraction(5000, 3000), 0)
  assert.equal(Model.progressFraction(-10, 3000), 1)
  assert.equal(Model.progressFraction(100, 0), 0)
})

test("phase glyphs are distinct per phase and breaks share the coffee glyph", () => {
  assert.equal(Model.phaseGlyph("work"), Model.GLYPHS.work)
  assert.equal(Model.phaseGlyph("short"), Model.GLYPHS.short)
  assert.equal(Model.phaseGlyph("long"), Model.GLYPHS.long)
  assert.notEqual(Model.phaseGlyph("work"), Model.phaseGlyph("short"))
})

test("a first completed block starts the streak at 1", () => {
  let state = Model.emptyState()
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 14))
  assert.equal(state.currentStreak, 1)
  assert.equal(state.bestStreak, 1)
  assert.equal(state.todayBlocks, 1)
  assert.equal(state.history["2026-09-14"], 1)
})

test("consecutive days extend the streak", () => {
  let state = Model.emptyState()
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 12))
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 13))
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 14))
  assert.equal(state.currentStreak, 3)
  assert.equal(state.todayBlocks, 1)
})

test("a missed day hard-resets the streak, as the captain ruled", () => {
  let state = Model.emptyState()
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 10))
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 11))
  // 12th missed
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 13))
  assert.equal(state.currentStreak, 1)
  assert.equal(state.bestStreak, 2)
})

test("several blocks in one day count once toward the streak", () => {
  let state = Model.emptyState()
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 14))
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 14))
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 14))
  assert.equal(state.currentStreak, 1)
  assert.equal(state.todayBlocks, 3)
  assert.equal(state.history["2026-09-14"], 3)
})

test("displayStreak keeps a streak alive through the day after the last block", () => {
  let state = Model.emptyState()
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 13))
  // Same day and the next day: still alive.
  assert.equal(Model.displayStreak(state, noon(2026, 9, 13)), 1)
  assert.equal(Model.displayStreak(state, noon(2026, 9, 14)), 1)
  // Two days later the chain is broken and the pill/panel must show 0.
  assert.equal(Model.displayStreak(state, noon(2026, 9, 15)), 0)
})

test("rollDay moves the daily counter and preserves history", () => {
  let state = Model.emptyState()
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 14))
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 14))
  const rolled = Model.rollDay(state, noon(2026, 9, 15))
  assert.equal(rolled.todayBlocks, 0)
  assert.equal(rolled.todayKey, "2026-09-15")
  assert.equal(rolled.history["2026-09-14"], 2)
  assert.equal(rolled.currentStreak, 1)
})

test("creditCurrentTask adds a pomodoro only to the current task", () => {
  const tasks = [
    { id: "a", text: "one", done: false, pomos: 1 },
    { id: "b", text: "two", done: false, pomos: 0 }
  ]
  const credited = Model.creditCurrentTask(tasks, "b")
  assert.equal(credited[0].pomos, 1)
  assert.equal(credited[1].pomos, 1)
  // The input array is not mutated.
  assert.equal(tasks[1].pomos, 0)
  assert.equal(Model.creditCurrentTask(tasks, "")[1].pomos, 0)
})

test("nextIncompleteTaskId skips done rows and honours the exclusion", () => {
  const tasks = [
    { id: "a", text: "one", done: true, pomos: 0 },
    { id: "b", text: "two", done: false, pomos: 0 },
    { id: "c", text: "three", done: false, pomos: 0 }
  ]
  assert.equal(Model.nextIncompleteTaskId(tasks), "b")
  assert.equal(Model.nextIncompleteTaskId(tasks, "b"), "c")
  assert.equal(Model.nextIncompleteTaskId(tasks, "c"), "b")
  assert.equal(Model.nextIncompleteTaskId([{ id: "a", text: "one", done: true, pomos: 0 }]), "")
})

test("parseState tolerates an empty, corrupt or foreign file", () => {
  for (const raw of ["", "null", "not json", "[]", "42"]) {
    const state = Model.parseState(raw)
    assert.equal(state.currentStreak, 0)
    assert.equal(state.phase, "work")
    assert.deepEqual(state.tasks, [])
  }
})

test("parseState drops unusable tasks and repoints a dangling current task", () => {
  const state = Model.parseState(JSON.stringify({
    version: 1,
    tasks: [
      { id: "a", text: "keep me", done: false, pomos: 2 },
      { id: "b", text: "   ", done: false },
      "garbage",
      null
    ],
    currentTaskId: "gone",
    phase: "sideways",
    currentStreak: -4,
    history: { "2026-09-14": 2, "not-a-day": 9, "2026-09-13": "x" }
  }))
  assert.equal(state.tasks.length, 1)
  assert.equal(state.tasks[0].text, "keep me")
  assert.equal(state.currentTaskId, "")
  assert.equal(state.phase, "work")
  assert.equal(state.currentStreak, 0)
  assert.deepEqual(state.history, { "2026-09-14": 2 })
})

test("state round-trips through serialize and parse", () => {
  let state = Model.emptyState()
  state.tasks = [{ id: "a", text: "write the spec", done: false, pomos: 3 }]
  state.currentTaskId = "a"
  state.phase = "short"
  state.pausedMs = 5 * 60 * 1000
  state.cycleBlocks = 2
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 14))
  const restored = Model.parseState(Model.serializeState(state))
  assert.deepEqual(restored.tasks, state.tasks)
  assert.equal(restored.currentTaskId, "a")
  assert.equal(restored.phase, "short")
  assert.equal(restored.pausedMs, state.pausedMs)
  assert.equal(restored.cycleBlocks, 2)
  assert.equal(restored.currentStreak, 1)
  assert.equal(restored.todayBlocks, 1)
  assert.equal(restored.history["2026-09-14"], 1)
})

test("recentDays reports the last N local days ending today", () => {
  let state = Model.emptyState()
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 14))
  state = Model.applyWorkBlockCompleted(state, noon(2026, 9, 12))
  const days = Model.recentDays(state, noon(2026, 9, 14), 4)
  assert.equal(days.length, 4)
  assert.deepEqual(days.map((d) => d.key), ["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"])
  assert.deepEqual(days.map((d) => d.hit), [false, true, false, true])
  assert.equal(days[3].today, true)
  assert.equal(days[3].count, 1)
})

test("history stays bounded for a very old state file", () => {
  const history = {}
  for (let i = 0; i < 500; i++) history[Model.shiftDayKey("2026-09-14", -i)] = 1
  const state = Model.parseState(JSON.stringify({ version: 1, history }))
  assert.ok(Object.keys(state.history).length <= 400)
  // The newest day survives the trim.
  assert.equal(state.history["2026-09-14"], 1)
})
