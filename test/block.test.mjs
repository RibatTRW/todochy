// The Block Core scenario harness.
//
// test/model.test.mjs checks the rules; this file drives the *lifecycle* — one
// countdown from arming to its consequence chain — through Block.js's single
// seam with an injected clock. No QML, no real time, no filesystem.
//
// Sections 9.2–9.6 of the plan's report drove four scenarios against the live
// plugin and recorded what a user saw. Scenario 3 could not be driven live
// (there is no pointer on the machine and no keyboard route into the add-task
// field), so it is covered here through the shipped functions. The first tests
// below replay those four scenarios step by step; the rest pin the behaviour
// contract item by item.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"
import { engineOps, seedTasks } from "./engine-ops.mjs"

const require = createRequire(import.meta.url)
const Block = require("../Block.js")
const Model = require("../Model.js")

const MIN = 60 * 1000
const HOUR = 60 * MIN

// Local noon avoids any timezone edge at the day boundary.
function noon(y, m, d) {
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime()
}
const T0 = noon(2026, 9, 14)

// One block, one clock, one settings value, one seam.
function harness(options) {
  const opts = options || {}
  let now = opts.now === undefined ? T0 : opts.now
  let settings = Object.assign({}, opts.settings || {})
  let block = opts.block ? opts.block : Block.empty()

  const h = {
    get now() { return now },
    get block() { return block },
    get settings() { return settings },

    at(ms) { now = ms; return h },
    wait(ms) { now += ms; return h },
    // A settings change, however it reached the engine: the panel's field or
    // `omarchy bar set`.
    configure(patch) {
      Object.assign(settings, patch)
      return h.send({ type: "SETTINGS_CHANGED" })
    },
    load(raw) { return h.send({ type: "LOAD", raw: raw || "" }) },
    send(event) {
      const value = typeof event === "string" ? { type: event } : event
      const result = Block.reduce(block, value, { now, settings })
      block = result.block
      return result
    },
    // Task CRUD is the engine's thin layer over Model, not the reducer.
    task(op, ...args) {
      const result = engineOps[op](block, ...args)
      block = result.block
      return result
    },
    remaining() { return Block.remainingMs(block, now) },
    deadline() { return block.deadlineMs },
    serialize() { return Block.serialize(block) }
  }
  return h
}

// A state.json v1 file, written the way the plugin writes it.
function v1(fields) {
  const payload = Object.assign({
    version: 1,
    tasks: [],
    currentTaskId: "",
    phase: "work",
    running: false,
    deadlineMs: 0,
    pausedMs: 0,
    cycleBlocks: 0,
    todayBlocks: 0,
    todayKey: "2026-09-14",
    history: {},
    currentStreak: 0,
    bestStreak: 0,
    lastCountedDay: "",
    notifyId: 0
  }, fields)
  return JSON.stringify(payload, null, 2) + "\n"
}

function loaded(options) {
  const h = harness(options)
  h.load((options && options.raw) || "")
  return h
}

// A one-minute work block, so a scenario can run to completion with a nod.
function quick(h) {
  h.configure({ workMinutes: 1 })
  return h
}

// ------------------------------------------------------- the four live scenarios

test("scenario 1: a paused block keeps its remaining time across a settings change", () => {
  const h = loaded({ now: T0 })
  h.send("START")
  h.wait(6 * 1000)
  h.send("TICK")
  h.send("PAUSE")

  const remaining = h.block.pausedMs
  assert.equal(remaining, 25 * MIN - 6000)

  // An unrelated phase length, then the armed phase's own length: both are
  // byte-identical, exactly as the live run showed 24:48 -> 24:48.
  const before = h.serialize()
  h.configure({ shortBreakMinutes: 7 })
  assert.equal(h.remaining(), remaining)
  assert.equal(h.serialize(), before)
  h.configure({ workMinutes: 40 })
  assert.equal(h.remaining(), remaining)
  assert.equal(h.serialize(), before)

  // The post-fix live run: 4:52 of a 5:00 block survives 5 -> 9 and 5 -> 25.
  const h2 = loaded({ settings: { workMinutes: 5 } })
  h2.send("START")
  h2.wait(8 * 1000)
  h2.send("PAUSE")
  assert.equal(h2.block.pausedMs, 5 * MIN - 8000)
  h2.configure({ shortBreakMinutes: 9 })
  h2.configure({ workMinutes: 25 })
  assert.equal(h2.block.pausedMs, 5 * MIN - 8000)
})

test("scenario 2: an idle block adopts a new length on the next start, a running one does not", () => {
  const h = loaded({ now: T0 })
  h.configure({ workMinutes: 1 })
  assert.equal(h.block.pausedMs, MIN, "the idle block at its full length adopts the new length")

  h.send("START")
  assert.equal(h.deadline(), T0 + MIN, "the next start uses the new length")
  h.wait(6 * 1000)
  h.send("TICK")
  const deadline = h.deadline()
  assert.equal(Math.round(h.remaining()), MIN - 6000)

  // A change while running keeps the deadline it started with.
  h.configure({ workMinutes: 25 })
  assert.equal(h.deadline(), deadline)
  assert.equal(Math.round(h.remaining()), MIN - 6000)

  // And the 1:00 block still completes naturally.
  h.wait(MIN)
  const result = h.send("TICK")
  assert.equal(h.block.phase, "short")
  assert.equal(h.block.cycleBlocks, 1)
  assert.equal(h.block.todayBlocks, 1)
  assert.equal(h.block.currentStreak, 1)
  assert.equal(h.block.pausedMs, 5 * MIN)
  assert.deepEqual(result.effects, [{ kind: "notify", phase: "short" }, { kind: "persist" }])
})

test("scenario 2: a paused block only adopts a length it had not started into", () => {
  const h = loaded({ settings: { workMinutes: 5 } })
  h.send("START")
  h.wait(8 * 1000)
  h.send("PAUSE")
  // 4:52 of 5:00 is partial, so a new 9-minute length must not rewind it.
  h.configure({ workMinutes: 9 })
  assert.equal(h.block.pausedMs, 5 * MIN - 8000)
  // A block paused at its full length has not started, so it does adopt.
  h.send("RESET")
  assert.equal(h.block.pausedMs, 9 * MIN)
  h.configure({ workMinutes: 12 })
  assert.equal(h.block.pausedMs, 12 * MIN)
})

test("scenario 3: adding a task moves the cursor only when there is no current task or it is done", () => {
  // No current task: the new task takes the cursor.
  const empty = loaded()
  empty.task("addTask", "first")
  assert.equal(empty.block.tasks.length, 1)
  assert.equal(empty.block.currentTaskId, empty.block.tasks[0].id)

  // The current task is incomplete: the cursor does not move.
  const open = loaded()
  open.task("addTask", "first")
  open.task("addTask", "second")
  assert.equal(open.block.currentTaskId, open.block.tasks[0].id)
  assert.equal(open.block.tasks.length, 2)

  // The current task is done: the new task takes the cursor.
  const done = loaded()
  done.task("addTask", "first")
  done.task("setTaskDone", done.block.tasks[0].id, true)
  done.task("addTask", "second")
  assert.equal(done.block.currentTaskId, done.block.tasks[1].id)

  // A dangling current task is dropped by the parse, so the add takes the cursor.
  const dangling = loaded({ raw: v1({ tasks: [{ id: "tA", text: "existing", done: false, pomos: 0 }], currentTaskId: "missing" }) })
  assert.equal(dangling.block.currentTaskId, "")
  dangling.task("addTask", "fresh")
  assert.equal(dangling.block.currentTaskId, dangling.block.tasks[1].id)

  // Blank text is rejected outright.
  const blank = loaded()
  blank.task("addTask", "   ")
  assert.deepEqual(blank.block.tasks, [])
})

test("scenario 4a: a task added after the current one completed takes the next block's credit", () => {
  // What the report drove live: a current task marked done, then a task added
  // (the add takes the cursor), then a real work block to completion.
  const h = quick(loaded({ now: T0 }))
  h.task("addTask", "Task A")
  const a = h.block.tasks[0].id
  h.task("setTaskDone", a, true)
  h.task("addTask", "Task B")
  const b = h.block.tasks[1].id
  assert.equal(h.block.currentTaskId, b)

  h.send("START")
  h.wait(2 * MIN)
  h.send("TICK")

  assert.equal(h.block.tasks[0].pomos, 0, "the completed task gets none")
  assert.equal(h.block.tasks[1].pomos, 1, "the added task gets the credit")
  assert.equal(h.block.currentTaskId, b, "the cursor stays: B is still open")
  assert.equal(h.block.todayBlocks, 1)
})

test("scenario 4b: a current task completed during the block advances the cursor", () => {
  const h = quick(loaded({ now: T0 }))
  h.task("addTask", "Task A")
  h.task("addTask", "Task B")
  const a = h.block.tasks[0].id
  const b = h.block.tasks[1].id
  assert.equal(h.block.currentTaskId, a)

  h.send("START")
  // The block runs on A; part-way through, the user marks the task it is
  // running on complete, which is what moves the cursor.
  h.wait(30 * 1000)
  h.task("setTaskDone", a, true)
  h.wait(30 * 1000)
  h.send("TICK")

  assert.equal(h.block.tasks[0].pomos, 1, "the block's credit went to the task it ran on")
  assert.equal(h.block.tasks[1].pomos, 0)
  assert.equal(h.block.currentTaskId, b, "the cursor moved to the next open task on the list")
})

// ------------------------------------------------------------ the block cadence

test("defaults are 25/5/15 with a long break every 4, and they clamp", () => {
  const h = loaded()
  assert.equal(h.block.pausedMs, 25 * MIN)
  const breaks = harness({ settings: { workMinutes: 1, longBreakEvery: 4 } })
  breaks.load("")
  const phases = []
  for (let i = 0; i < 8; i++) {
    if (breaks.block.phase !== "work") breaks.send("SKIP") // clear the break the last block armed
    breaks.send("START")
    breaks.send("WORK_COMPLETED")
    phases.push(breaks.block.phase)
  }
  assert.deepEqual(phases, ["short", "short", "short", "long", "short", "short", "short", "long"])

  // Clamping: workMinutes 0 -> 1, shortBreak 99999 -> 600, longBreak "x" -> 15,
  // longBreakEvery -2 -> 1, so every completed work block is followed by a long break.
  const clamped = harness({ settings: { workMinutes: 0, shortBreakMinutes: 99999, longBreakMinutes: "x", longBreakEvery: -2 } })
  clamped.load("")
  assert.equal(clamped.block.pausedMs, MIN)
  clamped.send("WORK_COMPLETED")
  assert.equal(clamped.block.phase, "long")
  assert.equal(clamped.block.pausedMs, 15 * MIN)
  clamped.send("WORK_COMPLETED")
  assert.equal(clamped.block.phase, "work")
  assert.equal(clamped.block.pausedMs, MIN)

  // shortBreakMinutes is clamped too, and it is the arm the short path uses.
  const shorts = harness({ settings: { workMinutes: 1, shortBreakMinutes: 99999, longBreakEvery: 9 } })
  shorts.load("")
  shorts.send("START")
  shorts.send("WORK_COMPLETED")
  assert.equal(shorts.block.phase, "short")
  assert.equal(shorts.block.pausedMs, 600 * MIN)
})

test("cycle position counts 1..N and wraps after the long break", () => {
  assert.equal(Block.cyclePosition(0, 4), 1)
  assert.equal(Block.cyclePosition(1, 4), 2)
  assert.equal(Block.cyclePosition(3, 4), 4)
  assert.equal(Block.cyclePosition(4, 4), 1)
  assert.equal(Block.cyclePosition(5, 4), 2)
  assert.equal(Block.cyclePosition(0, 0), 1)
})

test("a completed block never auto-starts the next one", () => {
  const h = quick(loaded())
  h.send("START")
  h.send("WORK_COMPLETED")
  assert.equal(h.block.running, false)
  assert.equal(h.block.deadlineMs, 0)
  assert.equal(h.block.pausedMs, 5 * MIN, "the break is armed at its full length and waits")
  const breakDone = h.send("WORK_COMPLETED")
  assert.deepEqual(breakDone.effects, [{ kind: "notify", phase: "work" }, { kind: "persist" }])
  assert.equal(h.block.running, false)
  assert.equal(h.block.phase, "work")
  assert.equal(h.block.pausedMs, MIN)
})

test("the countdown is derived from the wall clock, not accumulated from ticks", () => {
  const h = quick(loaded())
  h.send("START")
  h.wait(10 * 1000)
  h.send("TICK")
  // A suspend: 40 seconds of silence, one tick.
  h.wait(40 * 1000)
  h.send("TICK")
  assert.equal(Math.round(h.remaining()), 10 * 1000, "the countdown follows the clock, not the ticks")
  // Ticks never add or lose time, however many of them there are: 9 seconds of
  // ticks (and a few extra reads) leave exactly one second.
  for (let i = 0; i < 9; i++) h.wait(1000).send("TICK")
  assert.equal(Math.round(h.remaining()), 1000)
  assert.equal(h.block.running, true)
  // The last second ends the block exactly once.
  const result = h.wait(1000).send("TICK")
  assert.equal(h.block.running, false)
  assert.equal(h.block.phase, "short")
  assert.deepEqual(result.effects, [{ kind: "notify", phase: "short" }, { kind: "persist" }])
})

test("skip never credits anything and re-arms the phase at full length", () => {
  const h = quick(loaded({ now: T0 }))
  h.task("addTask", "Task A")
  h.send("START")
  h.wait(30 * 1000)
  const result = h.send("SKIP")
  assert.equal(h.block.todayBlocks, 0)
  assert.deepEqual(h.block.history, {})
  assert.equal(h.block.currentStreak, 0)
  assert.equal(h.block.lastCountedDay, "")
  assert.equal(h.block.tasks[0].pomos, 0)
  assert.equal(h.block.cycleBlocks, 0, "a skip does not advance the cycle")
  assert.equal(h.block.phase, "short")
  assert.equal(h.block.pausedMs, 5 * MIN)
  assert.deepEqual(result.effects, [{ kind: "persist" }], "a skip says nothing")
})

test("skip on a break returns to work without touching the streak", () => {
  const h = quick(loaded())
  h.send("START")
  h.send("WORK_COMPLETED")
  const credit = h.block
  h.send("START")
  h.send("SKIP")
  assert.equal(h.block.phase, "work")
  assert.equal(h.block.pausedMs, MIN)
  assert.equal(h.block.todayBlocks, credit.todayBlocks)
  assert.equal(h.block.currentStreak, credit.currentStreak)
})

test("reset stops the block and re-arms the current phase, and credits nothing", () => {
  const h = quick(loaded())
  h.task("addTask", "Task A")
  h.send("START")
  h.wait(30 * 1000)
  const result = h.send("RESET")
  assert.equal(h.block.running, false)
  assert.equal(h.block.deadlineMs, 0)
  assert.equal(h.block.pausedMs, MIN)
  assert.equal(h.block.phase, "work")
  assert.equal(h.block.todayBlocks, 0)
  assert.equal(h.block.tasks[0].pomos, 0)
  assert.deepEqual(result.effects, [{ kind: "persist" }])
  // A reset while idle is a no-op in effect but still re-arms.
  assert.equal(h.send("RESET").block.pausedMs, MIN)
})

// ------------------------------------------------- the completion consequence chain

test("a natural work completion does the whole chain at once", () => {
  const h = quick(loaded({ now: T0 }))
  h.send("START")
  const result = h.send("WORK_COMPLETED")
  assert.equal(h.block.todayBlocks, 1)
  assert.equal(h.block.history["2026-09-14"], 1)
  assert.equal(h.block.currentStreak, 1)
  assert.equal(h.block.bestStreak, 1)
  assert.equal(h.block.lastCountedDay, "2026-09-14")
  assert.equal(h.block.cycleBlocks, 1)
  assert.deepEqual(result.effects, [{ kind: "notify", phase: "short" }, { kind: "persist" }])
})

test("the completion chain credits before it moves the cursor", () => {
  const h = quick(loaded({ now: T0 }))
  h.task("addTask", "Task A")
  h.task("addTask", "Task B")
  const a = h.block.tasks[0].id
  const b = h.block.tasks[1].id
  h.task("setTaskDone", a, true)
  h.send("START")
  const result = h.send("WORK_COMPLETED")
  assert.deepEqual(result.effects, [
    { kind: "credit", taskId: a },
    { kind: "notify", phase: "short" },
    { kind: "persist" }
  ])
  assert.equal(h.block.tasks[0].pomos, 1)
  assert.equal(h.block.currentTaskId, b)
})

test("a work completion with no current task credits nothing but still counts", () => {
  const h = quick(loaded({ now: T0 }))
  h.send("START")
  const result = h.send("WORK_COMPLETED")
  assert.deepEqual(result.effects, [{ kind: "notify", phase: "short" }, { kind: "persist" }])
  assert.equal(h.block.todayBlocks, 1)
})

test("a completion leaves the cursor alone when the task is still open", () => {
  const h = quick(loaded({ now: T0 }))
  h.task("addTask", "Task A")
  const a = h.block.tasks[0].id
  h.send("START")
  h.send("WORK_COMPLETED")
  assert.equal(h.block.currentTaskId, a)
})

test("the streak continues across days, resets after a missed day, and bestStreak keeps the maximum", () => {
  const h = quick(loaded({ now: noon(2026, 9, 10) }))
  const complete = (day) => {
    h.at(day)
    h.send("TICK")
    if (h.block.phase !== "work") h.send("SKIP") // clear the break the last block left armed
    h.send("START")
    h.send("WORK_COMPLETED")
  }
  complete(noon(2026, 9, 10))
  assert.equal(h.block.currentStreak, 1)
  complete(noon(2026, 9, 11))
  assert.equal(h.block.currentStreak, 2)
  // The 12th is missed.
  complete(noon(2026, 9, 13))
  assert.equal(h.block.currentStreak, 1)
  assert.equal(h.block.bestStreak, 2)
  assert.equal(h.block.history["2026-09-10"], 1)
  assert.equal(h.block.history["2026-09-13"], 1)
  // Two blocks in one day count once.
  complete(noon(2026, 9, 13))
  assert.equal(h.block.currentStreak, 1)
  assert.equal(h.block.todayBlocks, 2)
  assert.equal(h.block.history["2026-09-13"], 2)
})

test("a break completion credits nothing and moves no streak", () => {
  const h = quick(loaded({ now: T0 }))
  h.send("START")
  h.send("WORK_COMPLETED")
  const afterWork = h.block
  h.send("START")
  const result = h.send("WORK_COMPLETED")
  assert.equal(h.block.phase, "work")
  assert.equal(h.block.todayBlocks, afterWork.todayBlocks)
  assert.equal(h.block.currentStreak, afterWork.currentStreak)
  assert.equal(h.block.history["2026-09-14"], afterWork.history["2026-09-14"])
  assert.deepEqual(result.effects, [{ kind: "notify", phase: "work" }, { kind: "persist" }])
})

// ------------------------------------------------------------------ day rollover

test("today rolls over on the ticker while idle, so 'today' is never yesterday's count", () => {
  const h = quick(loaded({ now: noon(2026, 9, 14) }))
  h.send("START")
  h.send("WORK_COMPLETED")
  assert.equal(h.block.todayBlocks, 1)
  h.at(noon(2026, 9, 15))
  const result = h.send("TICK")
  assert.equal(h.block.todayBlocks, 0)
  assert.equal(h.block.todayKey, "2026-09-15")
  assert.equal(h.block.history["2026-09-14"], 1, "history keeps yesterday")
  assert.deepEqual(result.effects, [{ kind: "persist" }])
  // Ticking again on the same day changes nothing at all.
  assert.deepEqual(h.send("TICK").effects, [])
})

test("a displayed streak is 0 once the last counted day is older than yesterday", () => {
  const h = quick(loaded({ now: noon(2026, 9, 14) }))
  h.send("START")
  h.send("WORK_COMPLETED")
  assert.equal(Model.displayStreak(h.block, noon(2026, 9, 14)), 1)
  assert.equal(Model.displayStreak(h.block, noon(2026, 9, 15)), 1)
  assert.equal(Model.displayStreak(h.block, noon(2026, 9, 16)), 0)
})

test("a work block that expires across midnight lands its credit on the right day", () => {
  const late = new Date(2026, 8, 14, 23, 59, 0, 0).getTime()
  const h = quick(loaded({ now: late }))
  h.send("START")
  h.at(late + 2 * MIN)
  h.send("TICK")
  assert.equal(h.block.todayKey, "2026-09-15")
  assert.equal(h.block.todayBlocks, 1)
  assert.equal(h.block.history["2026-09-15"], 1)
  assert.equal(h.block.lastCountedDay, "2026-09-15")
})

// ------------------------------------------------------- settings-change semantics

test("a settings change is one rule whoever makes it", () => {
  // Idle and fresh: adopt.
  const idle = loaded()
  idle.configure({ workMinutes: 50 })
  assert.equal(idle.block.pausedMs, 50 * MIN)
  // Paused with progress: keep it.
  idle.send("START")
  idle.wait(60 * 1000)
  idle.send("PAUSE")
  idle.configure({ workMinutes: 25 })
  assert.equal(idle.block.pausedMs, 49 * MIN)
  // Running: keep the deadline.
  idle.send("START")
  const deadline = idle.deadline()
  idle.configure({ workMinutes: 5 })
  assert.equal(idle.deadline(), deadline)
  // Running also keeps the length the run was armed from, so the mid-run 5:00
  // cannot become the length the next pause is measured against. A fresh run is
  // used here because `idle` is already paused-partial above, and a settings
  // change made while *paused* still re-arms the length it is measured against
  // (a separate defect, recorded and left alone).
  const run = loaded({ settings: { workMinutes: 50 } })
  run.send("START")
  const runDeadline = run.deadline()
  run.wait(60 * 1000)
  run.send("TICK")
  run.configure({ workMinutes: 5 })
  assert.equal(run.deadline(), runDeadline, "a running block keeps the deadline it started with")
  assert.equal(run.remaining(), 49 * MIN, "and its countdown does not move")
  run.send("PAUSE")
  assert.equal(run.block.pausedMs, 49 * MIN)
  run.configure({ workMinutes: 10 })
  assert.equal(run.block.pausedMs, 49 * MIN, "the mid-run length never becomes the pause's length")
  // Unrelated phase lengths never touch the countdown.
  const other = loaded()
  other.configure({ shortBreakMinutes: 11, longBreakMinutes: 22, longBreakEvery: 9 })
  assert.equal(other.block.pausedMs, 25 * MIN)
})

test("a settings change while running keeps the length the run was armed from", () => {
  // The defect this branch fixes, in the captain's own sequence: a block armed
  // at 40:00, run for a minute, the interval moved to 25 mid-run, paused with
  // 39:00 of work genuinely left, then moved to 30. The 25:00 written while the
  // block ran used to become the length the pause was measured against, so the
  // 39:00 was silently adopted down to 30:00.
  const h = loaded({ now: T0, settings: { workMinutes: 40 } })
  h.send("START")
  h.wait(MIN)
  h.send("TICK")
  h.configure({ workMinutes: 25 })
  assert.equal(h.remaining(), 39 * MIN, "the running 40:00 block keeps its deadline")
  h.send("PAUSE")
  assert.equal(h.remaining(), 39 * MIN, "39:00 of real work is left")
  h.configure({ workMinutes: 30 })
  assert.equal(h.remaining(), 39 * MIN, "and the new 30:00 does not rewrite it")

  // The neighbouring cases are untouched. A block that has not started still
  // adopts a new length, and a running block still keeps its deadline and its
  // countdown across a change.
  const fresh = loaded({ settings: { workMinutes: 25 } })
  fresh.configure({ workMinutes: 50 })
  assert.equal(fresh.block.pausedMs, 50 * MIN, "an unstarted block still adopts the new length")
  fresh.send("START")
  const deadline = fresh.deadline()
  fresh.wait(30 * 1000)
  fresh.configure({ workMinutes: 12 })
  assert.equal(fresh.deadline(), deadline, "a running block still keeps its deadline")
  assert.equal(fresh.remaining(), 50 * MIN - 30 * 1000, "and its countdown does not move")
})

test("an unchanged phase length is not a settings change at all", () => {
  const h = loaded()
  const before = h.serialize()
  const result = h.configure({ workMinutes: 25 })
  assert.deepEqual(result.effects, [])
  assert.equal(h.serialize(), before)
  assert.equal(result.block, h.block, "the value is returned untouched")
})

test("settings changed while running are picked up by the next phase", () => {
  const h = quick(loaded())
  h.send("START")
  h.configure({ shortBreakMinutes: 3 })
  h.send("WORK_COMPLETED")
  assert.equal(h.block.phase, "short")
  assert.equal(h.block.pausedMs, 3 * MIN)
  assert.equal(h.block.armedMs, 3 * MIN)
})

// ---------------------------------------------------------- the session seam

test("a run that expired within six hours completes on load", () => {
  const raw = v1({
    tasks: [{ id: "tA", text: "job", done: false, pomos: 0 }],
    currentTaskId: "tA",
    cycleBlocks: 2,
    todayBlocks: 1,
    history: { "2026-09-14": 1 },
    currentStreak: 1,
    bestStreak: 1,
    lastCountedDay: "2026-09-14",
    running: true,
    deadlineMs: T0 - HOUR
  })
  const h = harness({ now: T0, settings: { workMinutes: 1 } })
  const result = h.load(raw)
  assert.equal(h.block.running, false)
  assert.equal(h.block.todayBlocks, 2)
  assert.equal(h.block.currentStreak, 1, "already counted today")
  assert.equal(h.block.tasks[0].pomos, 1)
  assert.equal(h.block.cycleBlocks, 3)
  assert.equal(h.block.phase, "short")
  assert.deepEqual(result.effects, [
    { kind: "credit", taskId: "tA" },
    { kind: "notify", phase: "short" },
    { kind: "persist" }
  ])
})

test("the catch-up window is exactly six hours, and older runs are abandoned", () => {
  const running = (agoMs) => v1({ running: true, deadlineMs: T0 - agoMs, todayBlocks: 1, history: { "2026-09-14": 1 }, currentStreak: 1, bestStreak: 1, lastCountedDay: "2026-09-14" })
  const inside = harness({ now: T0, settings: { workMinutes: 1 } })
  inside.load(running(Block.MAX_CATCH_UP_MS))
  assert.equal(inside.block.todayBlocks, 2, "exactly six hours still completes")

  const outside = harness({ now: T0, settings: { workMinutes: 1 } })
  const result = outside.load(running(Block.MAX_CATCH_UP_MS + 1))
  assert.equal(outside.block.todayBlocks, 1, "one millisecond older is abandoned")
  assert.equal(outside.block.running, false)
  assert.equal(outside.block.deadlineMs, 0)
  assert.equal(outside.block.pausedMs, MIN, "idle at the current phase's full length")
  assert.deepEqual(result.effects, [{ kind: "persist" }], "abandoning never notifies or credits")
})

test("load keeps a future deadline, a partial pause, and arms everything else", () => {
  const future = harness({ now: T0, settings: { workMinutes: 1 } })
  future.load(v1({ running: true, deadlineMs: T0 + 30 * 1000 }))
  assert.equal(future.block.running, true)
  assert.equal(future.block.deadlineMs, T0 + 30 * 1000)
  assert.equal(Math.round(future.remaining()), 30 * 1000)

  const partial = harness({ now: T0, settings: { workMinutes: 1 } })
  partial.load(v1({ pausedMs: 20 * 1000 }))
  assert.equal(partial.block.pausedMs, 20 * 1000)

  const fresh = loaded({ settings: { workMinutes: 1 } })
  assert.equal(fresh.block.pausedMs, MIN)

  // A state file that says "running" without a deadline is not running.
  const dangling = loaded({ raw: v1({ running: true, deadlineMs: 0 }), settings: { workMinutes: 1 } })
  assert.equal(dangling.block.running, false)
  assert.equal(dangling.block.pausedMs, MIN)
})

test("load rolls the day even when the block it loads is complete", () => {
  const raw = v1({ todayBlocks: 3, todayKey: "2026-09-13", history: { "2026-09-13": 3 } })
  const h = harness({ now: noon(2026, 9, 14) })
  h.load(raw)
  assert.equal(h.block.todayKey, "2026-09-14")
  assert.equal(h.block.todayBlocks, 0)
  assert.equal(h.block.history["2026-09-13"], 3)
})

// --------------------------------------------------------- the state file, v1

test("state.json v1 round-trips byte for byte", () => {
  const raw = v1({
    tasks: [
      { id: "tA", text: "write the spec", done: false, pomos: 3 },
      { id: "tB", text: "ship it", done: true, pomos: 1 }
    ],
    currentTaskId: "tA",
    phase: "long",
    deadlineMs: 1234567,
    pausedMs: 1500000,
    cycleBlocks: 3,
    todayBlocks: 2,
    todayKey: "2026-09-14",
    history: { "2026-09-12": 1, "2026-09-13": 2, "2026-09-14": 2 },
    currentStreak: 3,
    bestStreak: 7,
    lastCountedDay: "2026-09-14",
    notifyId: 991
  })
  assert.equal(Block.serialize(Block.parseState(raw)), raw)
  // And the parsed value carries the transient armed length, unpersisted.
  assert.equal(Block.parseState(raw).armedMs, 0)
  assert.equal(JSON.parse(Block.serialize(Block.parseState(raw))).armedMs, undefined)
})

test("a v1 file written by the shipped plugin keeps its exact bytes through a load", () => {
  const raw = v1({ tasks: [{ id: "tA", text: "job", done: false, pomos: 2 }], currentTaskId: "tA", pausedMs: 60000 })
  const h = loaded({ raw })
  assert.equal(h.block.tasks[0].pomos, 2)
  // A fresh arm of the work phase is the only thing a load may change here.
  assert.equal(Block.serialize(Object.assign({}, h.block, { pausedMs: 60000 })), raw)
})

test("parsing stays defensive about a corrupt or foreign file", () => {
  for (const raw of ["", "null", "not json", "[]", "42", "{}"]) {
    const block = Block.parseState(raw)
    assert.deepEqual(block.tasks, [])
    assert.equal(block.phase, "work")
    assert.equal(block.currentStreak, 0)
    assert.equal(block.armedMs, 0)
  }
  const messy = Block.parseState(JSON.stringify({
    version: 1,
    tasks: [
      { id: "a", text: "keep me", done: false, pomos: 2 },
      { id: "b", text: "   " },
      "garbage",
      null,
      { text: "no id" }
    ],
    currentTaskId: "gone",
    phase: "sideways",
    running: "yes",
    deadlineMs: -5,
    pausedMs: "x",
    cycleBlocks: -3,
    todayBlocks: 1.7,
    todayKey: 9,
    history: { "2026-09-14": 2, "not-a-day": 9, "2026-09-13": "x" },
    currentStreak: -4,
    bestStreak: -9,
    lastCountedDay: null,
    notifyId: -1
  }))
  assert.equal(messy.tasks.length, 2)
  assert.equal(messy.tasks[0].text, "keep me")
  assert.equal(messy.tasks[1].text, "no id")
  assert.equal(messy.currentTaskId, "", "a dangling current task is repointed to nothing")
  assert.equal(messy.phase, "work")
  assert.equal(messy.running, false)
  assert.equal(messy.deadlineMs, 0)
  assert.equal(messy.pausedMs, 0)
  assert.equal(messy.cycleBlocks, 0)
  assert.equal(messy.todayBlocks, 1)
  assert.equal(messy.todayKey, "")
  assert.deepEqual(messy.history, { "2026-09-14": 2 })
  assert.equal(messy.currentStreak, 0)
  assert.equal(messy.bestStreak, 0)
  assert.equal(messy.lastCountedDay, "")
  assert.equal(messy.notifyId, 0)
})

test("bestStreak can never sit below currentStreak, and history stays bounded", () => {
  const repaired = Block.parseState(JSON.stringify({ currentStreak: 6, bestStreak: 2 }))
  assert.equal(repaired.bestStreak, 6)

  const history = {}
  for (let i = 0; i < 500; i++) history[Model.dayKey(T0 - i * 24 * HOUR)] = 1
  const bounded = Block.parseState(JSON.stringify({ history }))
  assert.ok(Object.keys(bounded.history).length <= 400)
  assert.equal(bounded.history[Model.dayKey(T0)], 1, "the newest day survives the trim")
})

// ---------------------------------------------------------- effects and clock

test("effects are data: every event names exactly what the engine must do", () => {
  const raw = v1({ tasks: [{ id: "tA", text: "job", done: false, pomos: 0 }], currentTaskId: "tA" })
  const h = harness({ now: T0, block: Block.parseState(raw), settings: { workMinutes: 1 } })

  assert.deepEqual(h.send("START").effects, [{ kind: "persist" }])
  assert.deepEqual(h.send("START").effects, [], "starting twice does nothing")
  assert.deepEqual(h.send("PAUSE").effects, [{ kind: "persist" }])
  assert.deepEqual(h.send("PAUSE").effects, [], "pausing an idle block does nothing")
  assert.deepEqual(h.send("RESET").effects, [{ kind: "persist" }])
  assert.deepEqual(h.send("SKIP").effects, [{ kind: "persist" }])
  assert.deepEqual(h.send("WORK_COMPLETED").effects, [{ kind: "notify", phase: "work" }, { kind: "persist" }])
  assert.deepEqual(h.send({ type: "NOTIFY_SENT", id: 77 }).effects, [{ kind: "persist" }])
  assert.equal(h.block.notifyId, 77)
  assert.deepEqual(h.send({ type: "NOTIFY_SENT", id: 0 }).effects, [], "no id means no change")
  assert.deepEqual(h.send({ type: "UNKNOWN" }).effects, [])
  assert.equal(h.send({ type: "UNKNOWN" }).block, h.block)
})

test("the armed phase length is the only thing a settings change moves while running", () => {
  const h = loaded({ now: T0 })
  h.send("START")
  const committed = h.serialize()
  const result = h.configure({ workMinutes: 60 })
  assert.deepEqual(result.effects, [], "nothing to persist: the armed length is not in the file")
  assert.equal(h.serialize(), committed, "and the file it would have written is byte-identical")
  // The change still lands: the next arming of this phase uses it.
  h.send("RESET")
  assert.equal(h.block.pausedMs, 60 * MIN)
})

test("the module never reads a clock: the same event at two clocks is two answers", () => {
  const a = harness({ now: T0, settings: { workMinutes: 1 } })
  a.load("")
  a.send("START")
  const b = harness({ now: T0, settings: { workMinutes: 1 } })
  b.load("")
  b.send("START")
  // Identical event, different injected time: the deadline is the only mover.
  a.at(T0 + 30 * 1000)
  const ra = a.send("TICK")
  b.at(T0 + 10 * 1000)
  const rb = b.send("TICK")
  assert.equal(ra.block.deadlineMs, rb.block.deadlineMs)
  assert.equal(Block.remainingMs(ra.block, a.now), 30 * 1000)
  assert.equal(Block.remainingMs(rb.block, b.now), 50 * 1000)
})

test("remainingMs is a function of the block and the clock, nothing else", () => {
  const h = loaded()
  assert.equal(Block.remainingMs(h.block, T0), 25 * MIN)
  h.send("START")
  assert.equal(Block.remainingMs(h.block, T0 + MIN), 24 * MIN)
  assert.equal(Block.remainingMs(h.block, T0 + 100 * MIN), 0, "never negative")
  assert.equal(Block.remainingMs(null, T0), 0)
})

test("a tick that has nothing to do does not need the settings at all", () => {
  // The 250 ms ticker runs this four times a second, so the tick path resolves
  // no settings and allocates nothing when nothing changed.
  const loaded = Block.reduce(Block.empty(), { type: "LOAD", raw: "" }, { now: T0, settings: {} })
  const block = loaded.block
  const missing = Block.reduce(block, { type: "TICK" }, { now: T0 })
  assert.equal(missing.block, block)
  assert.deepEqual(missing.effects, [])
  // A context with no clock at all reads as the epoch, not as a crash.
  const noClock = Block.reduce(block, { type: "TICK" }, {})
  assert.equal(noClock.block.todayKey, "1970-01-01")
})
