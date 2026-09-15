// Old engine vs new Block Core, driven over the same scripted event sequence.
//
// test/engine-reference.mjs is a frozen copy of the engine as it behaved at
// a8a6592 (the commit before this refactor): Model.js verbatim plus a
// transcription of Engine.qml's transition functions with an injected clock.
// This file drives that engine and Block.js through identical event sequences
// and asserts that the persisted v1 state is byte-identical after every step,
// and that the observable effects (a toast fired, a pomodoro credited) are the
// same list in the same order.
//
// `persist` is compared too, except on a step that models the panel's own
// `setSetting()`: there the old engine wrote the same bytes twice (once from
// the reactive settings handler, once from its inline re-arm) and the new one
// writes once. A redundant atomic rewrite of identical bytes is not visible to
// a user; everything else must match exactly, which is why the state bytes are
// compared on every step without exception.
//
// Task ids are generated at random by `Model.normalizeTask`, so task ids are
// canonicalised to their position before comparing states. Everything else is
// compared literally.
//
// ONE expectation is restated. The frozen engine re-arms the phase length on a
// settings change even while a block is running, which lets a later change made
// while paused shrink the work the block genuinely has left; that is the defect
// fm/todochy-paused-block-shrink fixes, so the frozen engine is deliberately no
// longer the oracle for that one step. A step can carry `restated` to name the
// fields the fixed rule decides instead: the value is asserted literally, and
// the frozen engine is then re-seated from the block, because the restated rule
// is the only difference between them and every later step is compared
// literally again. Only the case named below uses it.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { createLegacyEngine } from "./engine-reference.mjs"
import { engineOps } from "./engine-ops.mjs"

const require = createRequire(import.meta.url)
const Block = require("../Block.js")

const MIN = 60 * 1000
const HOUR = 60 * MIN

// Local noon avoids any timezone edge at the day boundary.
function noon(y, m, d) {
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime()
}
const T0 = noon(2026, 9, 14)

function step(at, event, extra) {
  return Object.assign({ at, event }, extra || {})
}

function rawState(fields) {
  return JSON.stringify(Object.assign({
    version: 1,
    tasks: [],
    currentTaskId: "",
    phase: "work",
    running: false,
    deadlineMs: 0,
    pausedMs: 0,
    cycleBlocks: 0,
    todayBlocks: 0,
    todayKey: "",
    history: {},
    currentStreak: 0,
    bestStreak: 0,
    lastCountedDay: "",
    notifyId: 0
  }, fields))
}

// Task ids are opaque and randomly generated on add, so compare them by
// position instead of by value.
function canonicalize(serialized) {
  const value = JSON.parse(serialized)
  const ids = new Map()
  value.tasks = (value.tasks || []).map((task, index) => {
    ids.set(task.id, `t${index}`)
    return Object.assign({}, task, { id: `t${index}` })
  })
  if (value.currentTaskId) value.currentTaskId = ids.get(value.currentTaskId) || "?"
  return JSON.stringify(value, null, 2)
}

function observable(effects, ignorePersist, tasks) {
  const ids = new Map((tasks || []).map((task, index) => [task.id, `t${index}`]))
  return effects
    .filter((e) => !(ignorePersist && e.kind === "persist"))
    .map((e) => (e.kind === "credit" ? Object.assign({}, e, { taskId: ids.get(e.taskId) || "?" }) : e))
}

// Re-seat the frozen engine from the block after a restated step: the v1 bytes
// it persists from here on are the block's, and `armedMs` - transient, not in
// the bytes - comes from the block too rather than being re-derived from the
// current settings.
function reseatLegacy(legacy, block) {
  legacy.loadState(Block.serialize(block))
  legacy.lastPhaseLengthMs = block.armedMs
}

function runScript(script, options) {
  const initialSettings = Object.assign({}, (options && options.settings) || {})
  let settings = initialSettings
  let now = script[0].at
  const legacy = createLegacyEngine({ now: () => now, settings: initialSettings })
  let block = Block.empty()

  script.forEach((entry, index) => {
    now = entry.at
    if (entry.settings) settings = entry.settings
    const type = entry.event.type
    let legacyEffects
    let blockResult
    let ignorePersist = entry.ignorePersist === true

    const taskIdAt = (side, i) => side.tasks[i] ? side.tasks[i].id : ""

    if (type === "SETTINGS_CHANGED") {
      settings = Object.assign({}, settings, entry.event.settings)
      legacyEffects = legacy.dispatch({ type: "SETTINGS_CHANGED", settings })
      blockResult = Block.reduce(block, { type: "SETTINGS_CHANGED" }, { now, settings })
    } else if (type === "SET_SETTING") {
      settings = Object.assign({}, settings, { [entry.event.key]: entry.event.value })
      legacyEffects = legacy.dispatch({ type: "SET_SETTING", key: entry.event.key, value: entry.event.value })
      blockResult = Block.reduce(block, { type: "SETTINGS_CHANGED" }, { now, settings })
      ignorePersist = true
    } else if (type === "ADD_TASK") {
      legacyEffects = legacy.dispatch({ type: "ADD_TASK", text: entry.event.text })
      blockResult = engineOps.addTask(block, entry.event.text)
    } else if (type === "SET_TASK_DONE") {
      legacyEffects = legacy.dispatch({ type: "SET_TASK_DONE", id: taskIdAt(legacy, entry.event.index), done: entry.event.done })
      blockResult = engineOps.setTaskDone(block, taskIdAt(block, entry.event.index), entry.event.done)
    } else if (type === "HANDLE_TASK_CLICK") {
      legacyEffects = legacy.dispatch({ type: "HANDLE_TASK_CLICK", id: taskIdAt(legacy, entry.event.index) })
      blockResult = engineOps.handleTaskClick(block, taskIdAt(block, entry.event.index))
    } else {
      legacyEffects = legacy.dispatch(entry.event)
      blockResult = Block.reduce(block, entry.event, { now, settings })
    }

    block = blockResult.block
    const label = `step ${index} ${type} @+${Math.round((entry.at - script[0].at) / 1000)}s`

    if (entry.restated) {
      Object.keys(entry.restated).forEach((field) => {
        assert.equal(block[field], entry.restated[field], `${label}: ${field} restated from the fixed rule, not the frozen engine`)
      })
      reseatLegacy(legacy, block)
      return
    }

    assert.equal(canonicalize(Block.serialize(block)), canonicalize(legacy.serialized()), `${label}: persisted state`)
    assert.deepEqual(
      observable(blockResult.effects, ignorePersist, block.tasks),
      observable(legacyEffects, ignorePersist, legacy.tasks),
      `${label}: effects`
    )
  })

  return { block, legacy }
}

test("equivalence: fresh load, pause, an unrelated and a related settings change, skip, reset", () => {
  runScript([
    step(T0, { type: "LOAD", raw: "" }),
    step(T0 + 1000, { type: "TICK" }),
    step(T0 + 2000, { type: "START" }),
    step(T0 + 32000, { type: "TICK" }),
    step(T0 + 32000, { type: "PAUSE" }),
    step(T0 + 33000, { type: "SETTINGS_CHANGED", settings: { shortBreakMinutes: 7 } }),
    step(T0 + 34000, { type: "SETTINGS_CHANGED", settings: { workMinutes: 40 } }),
    step(T0 + 35000, { type: "START" }),
    step(T0 + 95000, { type: "PAUSE" }),
    step(T0 + 96000, { type: "SET_SETTING", key: "workMinutes", value: 25 }),
    step(T0 + 97000, { type: "SKIP" }),
    step(T0 + 98000, { type: "RESET" }),
    step(T0 + 99000, { type: "PAUSE" }),
    step(T0 + 100000, { type: "SETTINGS_CHANGED", settings: { longBreakMinutes: 20 } })
  ])
})

test("equivalence: a settings change while running keeps the deadline and the next pause's remainder", () => {
  runScript([
    step(T0, { type: "LOAD", raw: "" }),
    step(T0, { type: "SETTINGS_CHANGED", settings: { workMinutes: 40 } }),
    step(T0 + 1000, { type: "START" }),
    step(T0 + 60000, { type: "TICK" }),
    // The settings now name a *shorter* phase than the block was armed with,
    // which is what makes the armed length observable at the next pause.
    step(T0 + 61000, { type: "SETTINGS_CHANGED", settings: { workMinutes: 25 } }),
    step(T0 + 62000, { type: "PAUSE" }),
    // The pause parked 38:59 of real work (40:00 armed, parked 61s after the
    // start). The frozen engine re-armed to the 25:00 written mid-run and so
    // overwrites that with 30:00 here - the defect this branch fixes - so this
    // single expectation is restated from the fixed rule, which keeps the 38:59
    // the block actually had left. The steps after it are compared literally
    // again (see reseatLegacy), so nothing else about the case is relaxed.
    step(T0 + 63000, { type: "SETTINGS_CHANGED", settings: { workMinutes: 30 } }, { restated: { pausedMs: 39 * MIN - 1000 } }),
    step(T0 + 64000, { type: "SETTINGS_CHANGED", settings: { workMinutes: 26 } }),
    step(T0 + 65000, { type: "START" }),
    step(T0 + 66000, { type: "SET_SETTING", key: "workMinutes", value: 20 }),
    step(T0 + 67000, { type: "PAUSE" })
  ])
})

test("equivalence: a natural work completion credits the task, the day and the streak", () => {
  const raw = rawState({
    tasks: [{ id: "tA", text: "write the spec", done: false, pomos: 2 }],
    currentTaskId: "tA",
    pausedMs: MIN,
    todayKey: "2026-09-14"
  })
  runScript([
    step(T0, { type: "LOAD", raw }),
    step(T0 + 1000, { type: "START" }),
    step(T0 + 2000, { type: "TICK" }),
    step(T0 + 61 * MIN, { type: "TICK" }),
    step(T0 + 61 * MIN + 1000, { type: "NOTIFY_SENT", id: 4242 }),
    step(T0 + 62 * MIN, { type: "START" }),
    step(T0 + 62 * MIN + 5 * MIN, { type: "WORK_COMPLETED" }),
    step(T0 + 62 * MIN + 6 * MIN, { type: "NOTIFY_SENT", id: 0 })
  ])
})

test("equivalence: the long break lands on the Nth block and a skip never advances the cycle", () => {
  const script = [step(T0, { type: "LOAD", raw: "" })]
  let at = T0
  for (let i = 1; i <= 5; i++) {
    at += MIN
    script.push(step(at, { type: "SETTINGS_CHANGED", settings: { workMinutes: 1 } }))
    at += MIN
    script.push(step(at, { type: "START" }))
    at += MIN
    script.push(step(at + 1000, { type: "TICK" }))
    at += MIN
    if (i < 4) script.push(step(at, { type: "SKIP" })) // a skipped block must not count toward the cycle
  }
  runScript(script)
})

test("equivalence: the task cursor on add, on completion and on a click", () => {
  const raw = rawState({
    tasks: [
      { id: "tA", text: "first", done: true, pomos: 1 },
      { id: "tB", text: "second", done: false, pomos: 0 }
    ],
    currentTaskId: "tA"
  })
  runScript([
    step(T0, { type: "LOAD", raw }),
    step(T0 + 1000, { type: "ADD_TASK", text: "third" }),
    step(T0 + 2000, { type: "SET_TASK_DONE", index: 1, done: true }),
    step(T0 + 3000, { type: "SETTINGS_CHANGED", settings: { workMinutes: 1 } }),
    step(T0 + 4000, { type: "START" }),
    step(T0 + 5000, { type: "WORK_COMPLETED" }),
    step(T0 + 6000, { type: "HANDLE_TASK_CLICK", index: 0 }),
    step(T0 + 7000, { type: "HANDLE_TASK_CLICK", index: 1 }),
    step(T0 + 8000, { type: "HANDLE_TASK_CLICK", index: 2 }),
    step(T0 + 9000, { type: "SETTINGS_CHANGED", settings: { workMinutes: 25 } })
  ])
})

test("equivalence: day rollover, a missed day and the streak counters", () => {
  runScript([
    step(noon(2026, 9, 10), { type: "LOAD", raw: "" }),
    step(noon(2026, 9, 10), { type: "SETTINGS_CHANGED", settings: { workMinutes: 1 } }),
    step(noon(2026, 9, 10) + MIN, { type: "START" }),
    step(noon(2026, 9, 10) + 2 * MIN, { type: "WORK_COMPLETED" }),
    step(noon(2026, 9, 11), { type: "TICK" }),
    step(noon(2026, 9, 11) + MIN, { type: "START" }),
    step(noon(2026, 9, 11) + 2 * MIN, { type: "WORK_COMPLETED" }),
    // The 12th is missed.
    step(noon(2026, 9, 13), { type: "TICK" }),
    step(noon(2026, 9, 13) + MIN, { type: "START" }),
    step(noon(2026, 9, 13) + 2 * MIN, { type: "WORK_COMPLETED" }),
    step(noon(2026, 9, 13) + 3 * MIN, { type: "START" }),
    step(noon(2026, 9, 13) + 4 * MIN, { type: "WORK_COMPLETED" })
  ])
})

test("equivalence: the six-hour catch-up window on load, and an abandoned run", () => {
  const running = {
    phase: "work",
    running: true,
    deadlineMs: 0,
    pausedMs: 0,
    todayKey: "2026-09-14",
    cycleBlocks: 1,
    todayBlocks: 1,
    history: { "2026-09-14": 1 },
    currentStreak: 1,
    bestStreak: 1,
    lastCountedDay: "2026-09-14"
  }
  // Expired an hour before load: it completes, and it is credited.
  runScript([
    step(T0, { type: "LOAD", raw: rawState(Object.assign({}, running, { deadlineMs: T0 - HOUR })) })
  ], { settings: { workMinutes: 1 } })
  // Expired seven hours before load: abandoned, idle at the phase's full length.
  runScript([
    step(T0, { type: "LOAD", raw: rawState(Object.assign({}, running, { deadlineMs: T0 - 7 * HOUR })) })
  ], { settings: { workMinutes: 1 } })
  // Still running with a future deadline: the deadline survives the restart.
  runScript([
    step(T0, { type: "LOAD", raw: rawState(Object.assign({}, running, { deadlineMs: T0 + 5 * MIN })) }),
    step(T0 + MIN, { type: "TICK" }),
    step(T0 + 6 * MIN, { type: "TICK" })
  ], { settings: { workMinutes: 1 } })
  // A paused block keeps its remaining time across the restart.
  runScript([
    step(T0, { type: "LOAD", raw: rawState({ pausedMs: 90 * 1000, todayKey: "2026-09-14" }) }),
    step(T0 + MIN, { type: "START" }),
    step(T0 + 2 * MIN, { type: "PAUSE" })
  ])
})
