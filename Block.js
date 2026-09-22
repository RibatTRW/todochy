// Block.js — the whole lifecycle of a todochy block, as one pure reducer.
//
// A "block" is the unit a user runs: one countdown on one phase (work, short
// break, long break). This file owns everything that can happen to it — arming
// a phase length, starting, pausing, skipping, resetting, the settings change
// that arrives mid-block, the day rollover, the six-hour catch-up window after
// a shell restart, and the entire consequence chain of a finished work block
// (today's count, history, the streak, the current task's credit and the task
// cursor). It is the only place any of those rules live.
//
// It is a value in, value out module:
//
//   var result = Block.reduce(block, { type: "START" }, { now: Date.now(), settings: settings })
//   result.block    // the next block value
//   result.effects  // [{ kind: "persist" } | { kind: "notify", phase } | { kind: "credit", taskId }]
//
// Nothing here reads a clock, a timer, a file or a Qt type, and nothing is kept
// between calls, so the whole lifecycle is exercised by test/block.test.mjs
// with an injected clock. The caller (Engine.qml) performs the effects: it
// writes state.json, sends the notification and owns the process and timer
// around them.
//
// Vocabulary
//   block        one run of one phase, from arm to end
//   arm          give the current countdown its full phase length
//   armedMs      the phase length the current countdown was armed from
//   phase        "work" | "short" | "long"
//   cadence      which phase follows a work block, and how far into the cycle
//   credit       a completed work block's pomodoro on the current task
//   completion   a block that reached its deadline, as opposed to a skip
//
// The block value is the state.json v1 shape plus `armedMs`. `armedMs` is
// deliberately not persisted: it is re-armed from the settings on every load,
// every phase transition, and every settings change that finds the block idle
// or paused at its full length. A change that arrives mid-run, or at a paused
// block holding partial progress, leaves it untouched, so neither the length a
// run was armed from nor a kept remainder can be rewritten. serialize() writes
// v1 byte-for-byte, and the round-trip test in test/block.test.mjs pins it.

// A run that expired while the shell was down still completes, but only if it
// expired recently: waking up a week later must not credit a week-old block.
var MAX_CATCH_UP_MS = 6 * 60 * 60 * 1000

var STATE_VERSION = 1
var MAX_HISTORY_DAYS = 400

// Model.js is pure and dependency-free, and this module composes its rules
// (settings clamping, phase lengths, calendar days, task rules). QML can only
// reach a second JS library through a `.import` directive, which is not valid
// JavaScript, so a file that must also be requirable by node cannot carry one.
// The QML side therefore hands the namespace over once, from Engine.qml:
//
//   import "Model.js" as Model
//   import "Block.js" as Block
//   ... Block.bindModel(Model)
//
// Under node the namespace is required directly here, so `require` sees a
// fully-usable module with no bind step.
var Model = (typeof module !== "undefined" && module.exports) ? require("./Model.js") : null

function bindModel(namespace) {
  Model = namespace
}

function model() {
  if (!Model) throw new Error("Block: the Model namespace is not bound; call Block.bindModel(Model) from QML")
  return Model
}

// Settings are clamped and defaulted once per event that reads them, never on
// the ticker's path: a tick that changes nothing must not allocate.
function settingsOf(ctx) {
  return model().normalizeSettings(ctx && ctx.settings)
}

// ---------------------------------------------------------------- primitives

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function finiteOr(value, fallback) {
  var n = Number(value)
  return isFinite(n) ? n : fallback
}

function copy(block) {
  return Object.assign({}, block)
}

function unchanged(block) {
  return { block: block, effects: [] }
}

// The countdown is derived from the wall clock, never accumulated from ticks,
// so suspending the machine or restarting the shell cannot skew it.
function remainingMs(block, now) {
  if (!block) return 0
  if (block.running === true) return Math.max(0, finiteOr(block.deadlineMs, 0) - finiteOr(now, 0))
  return Math.max(0, finiteOr(block.pausedMs, 0))
}

// ---------------------------------------------------------------- cadence

function boundedBlocks(value) {
  var n = Math.floor(finiteOr(value, 0))
  return n > 0 ? n : 0
}

function boundedEvery(value) {
  var n = Math.floor(finiteOr(value, 1))
  return n >= 1 ? n : 1
}

// Which break follows a completed work block. `cycleBlocks` is the count
// *after* the block that just completed, so 4 blocks with every=4 yields the
// long break.
function nextPhaseAfterWork(cycleBlocks, settings) {
  var every = boundedEvery(settings && settings.longBreakEvery)
  var blocks = boundedBlocks(cycleBlocks)
  return (blocks > 0 && blocks % every === 0) ? "long" : "short"
}

// 1-based position of the running work block inside the current cycle.
function cyclePosition(cycleBlocks, every) {
  return (boundedBlocks(cycleBlocks) % boundedEvery(every)) + 1
}

// ---------------------------------------------------------------- arming

// May a settings change adopt a new length into this block? Only into one that
// holds no progress of its own: fresh (nothing armed or nothing held), or
// paused at exactly the full length it was armed from. Any other held value is
// time the block earned — 40:00 armed with 39:00 left is work done, and a held
// time above the armed length is a remainder the settings moved out from under
// — so the change must not touch the block at all.
function canAdoptLength(block) {
  var armed = Number(block.armedMs)
  if (!isFinite(armed) || armed <= 0) return true
  var remaining = Number(block.pausedMs)
  if (!isFinite(remaining) || remaining <= 0) return true
  return remaining === armed
}

// ---------------------------------------------------------------- days

// One naturally completed work block: bumps today's count, writes history, and
// continues or restarts the streak. The hard reset is deliberate — the captain
// ruled out pause/freeze affordances, so a missed day restarts at 1.
function applyWorkBlockCompleted(block, now) {
  var M = model()
  var today = M.dayKey(now)
  var out = copy(block)
  if (out.todayKey !== today) {
    out.todayKey = today
    out.todayBlocks = 0
  }
  out.todayBlocks = out.todayBlocks + 1
  var history = Object.assign({}, out.history)
  history[out.todayKey] = out.todayBlocks
  out.history = history

  if (out.lastCountedDay === out.todayKey) {
    // Already counted today; keep the streak as it stands.
  } else if (out.lastCountedDay !== "" && out.lastCountedDay === M.previousDayKey(out.todayKey)) {
    out.currentStreak = out.currentStreak + 1
  } else {
    out.currentStreak = 1
  }
  out.lastCountedDay = out.todayKey
  if (out.currentStreak > out.bestStreak) out.bestStreak = out.currentStreak
  return out
}

// ---------------------------------------------------------------- the shape

function empty() {
  return {
    version: STATE_VERSION,
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
    notifyId: 0,
    // Transient: the phase length the current countdown was armed from. Not
    // persisted; re-armed by LOAD and by every phase transition.
    armedMs: 0
  }
}

function sanitizeHistory(value) {
  var out = {}
  if (!isPlainObject(value)) return out
  var keys = Object.keys(value)
  for (var i = 0; i < keys.length; i++) {
    var key = keys[i]
    if (!/^\d{4}-\d{2}-\d{2}$/.test(key)) continue
    var count = Math.max(0, Math.floor(finiteOr(value[key], 0)))
    if (count > 0) out[key] = count
  }
  // Keep the file bounded even after years of use.
  var all = Object.keys(out).sort()
  if (all.length > MAX_HISTORY_DAYS) {
    var kept = {}
    var start = all.length - MAX_HISTORY_DAYS
    for (var j = start; j < all.length; j++) kept[all[j]] = out[all[j]]
    return kept
  }
  return out
}

// The v1 state file is read defensively: unusable tasks are dropped, a dangling
// current task is repointed to nothing, counters are clamped, history keys are
// validated and bestStreak can never sit below currentStreak.
function parseState(raw) {
  var M = model()
  var block = empty()
  var parsed = null
  try { parsed = JSON.parse(String(raw || "")) } catch (e) { parsed = null }
  if (!isPlainObject(parsed)) return block

  if (Array.isArray(parsed.tasks)) {
    for (var i = 0; i < parsed.tasks.length; i++) {
      var task = M.normalizeTask(parsed.tasks[i])
      if (task) block.tasks.push(task)
    }
  }
  block.currentTaskId = (typeof parsed.currentTaskId === "string") ? parsed.currentTaskId : ""
  if (block.currentTaskId !== "" && !M.hasTask(block.tasks, block.currentTaskId)) block.currentTaskId = ""
  block.phase = normalizePhase(parsed.phase)
  block.running = parsed.running === true
  block.deadlineMs = Math.max(0, finiteOr(parsed.deadlineMs, 0))
  block.pausedMs = Math.max(0, finiteOr(parsed.pausedMs, 0))
  block.cycleBlocks = Math.max(0, Math.floor(finiteOr(parsed.cycleBlocks, 0)))
  block.todayBlocks = Math.max(0, Math.floor(finiteOr(parsed.todayBlocks, 0)))
  block.todayKey = (typeof parsed.todayKey === "string") ? parsed.todayKey : ""
  block.history = sanitizeHistory(parsed.history)
  block.currentStreak = Math.max(0, Math.floor(finiteOr(parsed.currentStreak, 0)))
  block.bestStreak = Math.max(0, Math.floor(finiteOr(parsed.bestStreak, 0)))
  block.lastCountedDay = (typeof parsed.lastCountedDay === "string") ? parsed.lastCountedDay : ""
  block.notifyId = Math.max(0, Math.floor(finiteOr(parsed.notifyId, 0)))
  if (block.bestStreak < block.currentStreak) block.bestStreak = block.currentStreak
  return block
}

function normalizePhase(phase) {
  return (phase === "work" || phase === "short" || phase === "long") ? phase : "work"
}

// The v1 file, byte for byte. `armedMs` is not part of it.
function serialize(block) {
  var s = block || empty()
  var payload = {
    version: STATE_VERSION,
    tasks: Array.isArray(s.tasks) ? s.tasks : [],
    currentTaskId: s.currentTaskId || "",
    phase: normalizePhase(s.phase),
    running: s.running === true,
    deadlineMs: Math.max(0, finiteOr(s.deadlineMs, 0)),
    pausedMs: Math.max(0, finiteOr(s.pausedMs, 0)),
    cycleBlocks: Math.max(0, Math.floor(finiteOr(s.cycleBlocks, 0))),
    todayBlocks: Math.max(0, Math.floor(finiteOr(s.todayBlocks, 0))),
    todayKey: typeof s.todayKey === "string" ? s.todayKey : "",
    history: sanitizeHistory(s.history),
    currentStreak: Math.max(0, Math.floor(finiteOr(s.currentStreak, 0))),
    bestStreak: Math.max(0, Math.floor(finiteOr(s.bestStreak, 0))),
    lastCountedDay: typeof s.lastCountedDay === "string" ? s.lastCountedDay : "",
    notifyId: Math.max(0, Math.floor(finiteOr(s.notifyId, 0)))
  }
  return JSON.stringify(payload, null, 2) + "\n"
}

// ------------------------------------------------------------- transitions

function start(block, now, settings) {
  if (block.running === true) return unchanged(block)
  var remaining = remainingMs(block, now)
  if (remaining <= 0) remaining = model().phaseLengthMs(settings, block.phase)
  var next = copy(block)
  next.pausedMs = remaining
  next.deadlineMs = now + remaining
  next.running = true
  return { block: next, effects: [{ kind: "persist" }] }
}

function pause(block, now) {
  if (block.running !== true) return unchanged(block)
  var next = copy(block)
  next.pausedMs = Math.max(0, finiteOr(block.deadlineMs, 0) - now)
  next.running = false
  next.deadlineMs = 0
  return { block: next, effects: [{ kind: "persist" }] }
}

// Reset stops the block and re-arms the current phase at full length. Like a
// skip it credits nothing.
function reset(block, settings) {
  var length = model().phaseLengthMs(settings, block.phase)
  var next = copy(block)
  next.running = false
  next.deadlineMs = 0
  next.pausedMs = length
  next.armedMs = length
  return { block: next, effects: [{ kind: "persist" }] }
}

// The cursor moves only when the task the block ran on had been marked
// complete during the block. Otherwise it stays where it is.
function taskIdAfterBlock(tasks, currentTaskId) {
  var current = null
  for (var i = 0; i < tasks.length; i++) if (tasks[i].id === currentTaskId) current = tasks[i]
  if (!current || current.done !== true) return currentTaskId
  var nextId = model().nextIncompleteTaskId(tasks, "")
  return nextId !== "" ? nextId : currentTaskId
}

// A block ending, naturally or by a skip. The completion consequence chain for
// a work block lives here in one piece: today's count, history, the streak, the
// current task's credit, then the cursor.
function finish(block, now, settings, natural) {
  var M = model()
  var next = copy(block)
  var effects = []

  if (block.phase === "work") {
    if (natural) {
      next = applyWorkBlockCompleted(next, now)
      next.cycleBlocks = block.cycleBlocks + 1
      var creditedId = next.currentTaskId
      next.tasks = M.creditCurrentTask(next.tasks, creditedId)
      if (creditedId !== "" && M.hasTask(next.tasks, creditedId)) effects.push({ kind: "credit", taskId: creditedId })
      next.currentTaskId = taskIdAfterBlock(next.tasks, next.currentTaskId)
    }
    next.phase = nextPhaseAfterWork(next.cycleBlocks, settings)
  } else {
    next.phase = "work"
  }

  next.running = false
  next.deadlineMs = 0
  next.pausedMs = M.phaseLengthMs(settings, next.phase)
  next.armedMs = next.pausedMs
  if (natural) effects.push({ kind: "notify", phase: next.phase })
  effects.push({ kind: "persist" })
  return { block: next, effects: effects }
}

function tick(block, now, ctx) {
  if (block.running === true && finiteOr(block.deadlineMs, 0) - now <= 0) return finish(block, now, settingsOf(ctx), true)
  // Roll the day at midnight even when nothing is running, so "today" never
  // shows yesterday's count.
  var today = model().dayKey(now)
  if (block.todayKey !== today) {
    var next = copy(block)
    next.todayKey = today
    next.todayBlocks = 0
    return { block: next, effects: [{ kind: "persist" }] }
  }
  return unchanged(block)
}

// A settings change reaches the engine from two places — the panel's fields and
// `omarchy bar set` / an edited shell.json — and both arrive as the settings
// value itself changing. This is the single handler for that invariant: a
// fresh or idle block adopts the new length, a paused block with partial
// progress keeps its remaining time, and a running block keeps the deadline it
// started with. The README promises all three, so the first two are guarded
// together: `armedMs` is what the pause rule measures "has this block started?"
// against, and it stays put whenever the block itself stays put.
//
// A running block keeps the length it was armed from: re-arming it mid-run
// would let a shorter value written while the user was working become the
// paused block's length (40:00 armed, 39:00 genuinely left, the settings moved
// to 25 mid-run, and the later pause is measured against 25).
//
// A paused block with partial progress likewise keeps its remainder *and* the
// length it was armed from — the block is returned untouched, so there is
// nothing to persist. Re-arming only the length here would set the same trap
// one change later: 39:00 kept across a change to 30, `armedMs` silently
// rewritten to 30:00, and the next change to 20 then adopts 20:00 over the
// user's real work. The change instead lands at the next arming: the next
// start resumes the kept remainder, and LOAD, a phase transition and a reset
// all re-arm from the settings as before.
function settingsChanged(block, settings) {
  if (block.running === true) return unchanged(block)
  if (!canAdoptLength(block)) return unchanged(block)
  var length = model().phaseLengthMs(settings, block.phase)
  if (length === block.armedMs) return unchanged(block)
  var next = copy(block)
  next.pausedMs = length
  next.armedMs = length
  return { block: next, effects: [{ kind: "persist" }] }
}

// The session seam: parse, roll the day, apply the six-hour catch-up policy and
// arm the current phase.
function load(event, now, settings) {
  var M = model()
  var block = parseState(event && event.raw)
  var today = M.dayKey(now)
  if (block.todayKey !== today) {
    block.todayKey = today
    block.todayBlocks = 0
  }

  if (block.running === true && block.deadlineMs > 0) {
    if (block.deadlineMs <= now) {
      if (now - block.deadlineMs <= MAX_CATCH_UP_MS) return finish(block, now, settings, true)
      // Abandoned: the session is over, and it is never credited.
      block.running = false
      block.deadlineMs = 0
      block.pausedMs = M.phaseLengthMs(settings, block.phase)
    }
  } else {
    block.running = false
    block.deadlineMs = 0
    if (block.pausedMs <= 0) block.pausedMs = M.phaseLengthMs(settings, block.phase)
  }

  block.armedMs = M.phaseLengthMs(settings, block.phase)
  return { block: block, effects: [{ kind: "persist" }] }
}

// The notification daemon assigns the id of the toast it replaced, and it is
// persisted so a shell restart replaces that toast instead of stacking a second
// one.
function notifySent(block, event) {
  var id = Math.floor(finiteOr(event && event.id, 0))
  if (id <= 0) return unchanged(block)
  var next = copy(block)
  next.notifyId = id
  return { block: next, effects: [{ kind: "persist" }] }
}

// ------------------------------------------------------------------- seam

// The one entry point. Event names are the domain's own words:
// START, PAUSE, SKIP, RESET, TICK, WORK_COMPLETED, SETTINGS_CHANGED, LOAD and
// NOTIFY_SENT.
function reduce(block, event, ctx) {
  var current = block || empty()
  var now = finiteOr(ctx && ctx.now, 0)
  var type = event && event.type

  if (type === "START") return start(current, now, settingsOf(ctx))
  if (type === "PAUSE") return pause(current, now)
  if (type === "SKIP") return finish(current, now, settingsOf(ctx), false)
  if (type === "RESET") return reset(current, settingsOf(ctx))
  if (type === "TICK") return tick(current, now, ctx)
  if (type === "WORK_COMPLETED") return finish(current, now, settingsOf(ctx), true)
  if (type === "SETTINGS_CHANGED") return settingsChanged(current, settingsOf(ctx))
  if (type === "LOAD") return load(event, now, settingsOf(ctx))
  if (type === "NOTIFY_SENT") return notifySent(current, event)
  return unchanged(current)
}

// ---------------------------------------------------------------- exports

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    MAX_CATCH_UP_MS: MAX_CATCH_UP_MS,
    bindModel: bindModel,
    empty: empty,
    parseState: parseState,
    serialize: serialize,
    remainingMs: remainingMs,
    nextPhaseAfterWork: nextPhaseAfterWork,
    cyclePosition: cyclePosition,
    reduce: reduce
  }
}
