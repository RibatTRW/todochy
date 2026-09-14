// Pure helpers for todochy: the rules that are not the block lifecycle.
//
// Everything here is plain JavaScript with no QML dependency so it can be
// exercised by the node test suite in test/model.test.mjs. This file is the
// library of primitives — settings clamping, phase lengths, formatting,
// calendar days, streak arithmetic and the task rules. The *lifecycle* that
// composes them (arming a countdown, a settings change arriving mid-block, the
// catch-up window, the completion consequence chain and the shape of the state
// file) lives in Block.js, which is the single owner of every one of those
// rules.
//
// Vocabulary
//   phase        "work" | "short" | "long"
//   cadence      which phase follows a work block (Block.js)
//   todayBlocks  work blocks completed today (local calendar day)
//   history      { "YYYY-MM-DD": <work blocks completed that day> }
//   streak       consecutive local days each with >= 1 completed work block

var DEFAULT_SETTINGS = {
  workMinutes: 25,
  shortBreakMinutes: 5,
  longBreakMinutes: 15,
  longBreakEvery: 4
}

// Nerd Font glyphs (Material Design Icons), verified present in the Nerd Font
// family Omarchy ships and uses across the bar.
var GLYPHS = {
  work: "\u{F051B}",   // md timer
  short: "\u{F0176}",  // md coffee
  long: "\u{F0176}",
  gear: "\u{F0493}",
  streak: "\u{25B2}"   // ▲
}

var MS_PER_MINUTE = 60 * 1000

// ---------------------------------------------------------------- primitives

function isPlainObject(value) {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function pad2(value) {
  var n = Math.floor(Math.abs(Number(value)))
  return n < 10 ? "0" + n : String(n)
}

function clampInt(value, min, max, fallback) {
  var n = Number(value)
  if (!isFinite(n)) return fallback
  n = Math.round(n)
  if (n < min) return min
  if (n > max) return max
  return n
}

function finiteOr(value, fallback) {
  var n = Number(value)
  return isFinite(n) ? n : fallback
}

// ---------------------------------------------------------------- phases

function normalizePhase(phase) {
  return (phase === "work" || phase === "short" || phase === "long") ? phase : "work"
}

function isBreakPhase(phase) {
  return phase === "short" || phase === "long"
}

function phaseGlyph(phase) {
  var p = normalizePhase(phase)
  if (p === "short") return GLYPHS.short
  if (p === "long") return GLYPHS.long
  return GLYPHS.work
}

function phaseLabel(phase) {
  var p = normalizePhase(phase)
  if (p === "short") return "Short break"
  if (p === "long") return "Long break"
  return "Focus"
}

function phaseMinutes(settings, phase) {
  var s = settings || DEFAULT_SETTINGS
  var p = normalizePhase(phase)
  if (p === "short") return clampInt(s.shortBreakMinutes, 1, 600, DEFAULT_SETTINGS.shortBreakMinutes)
  if (p === "long") return clampInt(s.longBreakMinutes, 1, 600, DEFAULT_SETTINGS.longBreakMinutes)
  return clampInt(s.workMinutes, 1, 600, DEFAULT_SETTINGS.workMinutes)
}

function phaseLengthMs(settings, phase) {
  return phaseMinutes(settings, phase) * MS_PER_MINUTE
}

function progressFraction(remainingMs, totalMs) {
  var total = Number(totalMs)
  if (!isFinite(total) || total <= 0) return 0
  var done = 1 - Number(remainingMs) / total
  if (!isFinite(done)) return 0
  if (done < 0) return 0
  if (done > 1) return 1
  return done
}

function formatMs(ms) {
  var total = Math.max(0, Math.floor(finiteOr(ms, 0) / 1000))
  var seconds = total % 60
  var minutes = Math.floor(total / 60) % 60
  var hours = Math.floor(total / 3600)
  if (hours > 0) return hours + ":" + pad2(minutes) + ":" + pad2(seconds)
  return pad2(minutes) + ":" + pad2(seconds)
}

// ---------------------------------------------------------------- days

function dayKey(epochMs) {
  var d = new Date(finiteOr(epochMs, Date.now()))
  return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate())
}

function shiftDayKey(key, days) {
  var parts = String(key || "").split("-")
  if (parts.length !== 3) return ""
  var year = Number(parts[0])
  var month = Number(parts[1])
  var day = Number(parts[2])
  if (!isFinite(year) || !isFinite(month) || !isFinite(day)) return ""
  var d = new Date(year, month - 1, day)
  if (!isFinite(d.getTime())) return ""
  d.setDate(d.getDate() + Math.round(finiteOr(days, 0)))
  return dayKey(d.getTime())
}

function previousDayKey(key) {
  return shiftDayKey(key, -1)
}

// ---------------------------------------------------------------- tasks

function newTaskId() {
  return "t" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}

function normalizeTask(value) {
  if (!isPlainObject(value)) return null
  var text = typeof value.text === "string" ? value.text : ""
  if (text.replace(/\s+/g, "") === "") return null
  return {
    id: (typeof value.id === "string" && value.id !== "") ? value.id : newTaskId(),
    text: text,
    done: value.done === true,
    pomos: Math.max(0, Math.floor(finiteOr(value.pomos, 0)))
  }
}

function hasTask(tasks, id) {
  for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) return true
  return false
}

function creditCurrentTask(tasks, currentTaskId) {
  if (!currentTaskId) return tasks
  var out = []
  for (var i = 0; i < tasks.length; i++) {
    var t = tasks[i]
    if (t.id === currentTaskId) out.push({ id: t.id, text: t.text, done: t.done, pomos: t.pomos + 1 })
    else out.push(t)
  }
  return out
}

function currentTaskIdAfterAdd(tasks, currentTaskId, newTaskId) {
  if (!newTaskId) return currentTaskId || ""
  if (!currentTaskId) return newTaskId
  var list = Array.isArray(tasks) ? tasks : []
  for (var i = 0; i < list.length; i++) {
    if (list[i].id === currentTaskId) return list[i].done === true ? newTaskId : currentTaskId
  }
  return newTaskId
}

// The next incomplete task in list order, or "" when none is left.
function nextIncompleteTaskId(tasks, excludeId) {
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i].done) continue
    if (excludeId && tasks[i].id === excludeId) continue
    return tasks[i].id
  }
  return ""
}

// ------------------------------------------------------- the streak's display

// What the user should see. A streak stays alive through today when the last
// counted day was yesterday; anything older means the chain is broken.
function displayStreak(state, epochMs) {
  var today = dayKey(epochMs)
  if (state.lastCountedDay === today) return state.currentStreak
  if (state.lastCountedDay === previousDayKey(today)) return state.currentStreak
  return 0
}

function recentDays(state, epochMs, count) {
  var n = clampInt(count, 1, 60, 14)
  var today = dayKey(epochMs)
  var history = (state && isPlainObject(state.history)) ? state.history : {}
  var out = []
  for (var i = n - 1; i >= 0; i--) {
    var key = shiftDayKey(today, -i)
    var hits = Math.max(0, Math.floor(finiteOr(history[key], 0)))
    out.push({ key: key, count: hits, hit: hits > 0, today: i === 0 })
  }
  return out
}

// ---------------------------------------------------------------- settings

function normalizeSettings(values) {
  var v = isPlainObject(values) ? values : {}
  return {
    workMinutes: clampInt(v.workMinutes, 1, 600, DEFAULT_SETTINGS.workMinutes),
    shortBreakMinutes: clampInt(v.shortBreakMinutes, 1, 600, DEFAULT_SETTINGS.shortBreakMinutes),
    longBreakMinutes: clampInt(v.longBreakMinutes, 1, 600, DEFAULT_SETTINGS.longBreakMinutes),
    longBreakEvery: clampInt(v.longBreakEvery, 1, 24, DEFAULT_SETTINGS.longBreakEvery)
  }
}

// ---------------------------------------------------------------- exports

if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    // Rendering primitives. Panel.qml and Engine.qml read these; nothing in
    // them has a rule attached to the lifecycle.
    GLYPHS: GLYPHS,
    isBreakPhase: isBreakPhase,
    phaseGlyph: phaseGlyph,
    phaseLabel: phaseLabel,
    progressFraction: progressFraction,
    formatMs: formatMs,
    // Settings and phase lengths. Block.js arms from these and Engine.qml
    // derives its displayed total from them.
    normalizeSettings: normalizeSettings,
    phaseLengthMs: phaseLengthMs,
    // Calendar days and the streak's display rule.
    dayKey: dayKey,
    previousDayKey: previousDayKey,
    recentDays: recentDays,
    displayStreak: displayStreak,
    // Task rules. Task CRUD in Engine.qml and the completion chain in Block.js
    // both call these.
    normalizeTask: normalizeTask,
    hasTask: hasTask,
    creditCurrentTask: creditCurrentTask,
    currentTaskIdAfterAdd: currentTaskIdAfterAdd,
    nextIncompleteTaskId: nextIncompleteTaskId
  }
}
