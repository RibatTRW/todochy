// Pure state and cadence logic for todochy.
//
// Everything here is plain JavaScript with no QML dependency so it can be
// exercised by the node test suite in test/model.test.mjs. The QML side
// (Engine.qml) owns timers, file IO and notifications and delegates every
// decision that has rules attached — phase cadence, streak accounting, day
// rollover, state parsing — to this file.
//
// Vocabulary
//   phase        "work" | "short" | "long"
//   cycleBlocks  work blocks completed in the current long-break cycle
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

var STATE_VERSION = 1
var MAX_HISTORY_DAYS = 400
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

function longBreakEvery(settings) {
  return clampInt(settings && settings.longBreakEvery, 1, 24, DEFAULT_SETTINGS.longBreakEvery)
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

// Which break follows a completed work block. `cycleBlocks` is the count
// *after* the block that just completed, so 4 blocks with every=4 yields the
// long break.
function nextPhaseAfterWork(cycleBlocks, every) {
  var e = clampInt(every, 1, 24, DEFAULT_SETTINGS.longBreakEvery)
  var blocks = Math.max(0, Math.floor(finiteOr(cycleBlocks, 0)))
  return (blocks > 0 && blocks % e === 0) ? "long" : "short"
}

// 1-based position of the running work block inside the current cycle.
function cyclePosition(cycleBlocks, every) {
  var e = clampInt(every, 1, 24, DEFAULT_SETTINGS.longBreakEvery)
  var blocks = Math.max(0, Math.floor(finiteOr(cycleBlocks, 0)))
  return (blocks % e) + 1
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

// The next incomplete task in list order, or "" when none is left.
function nextIncompleteTaskId(tasks, excludeId) {
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i].done) continue
    if (excludeId && tasks[i].id === excludeId) continue
    return tasks[i].id
  }
  return ""
}

// ---------------------------------------------------------------- state

function emptyState() {
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
    notifyId: 0
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

function parseState(raw) {
  var state = emptyState()
  var parsed = null
  try { parsed = JSON.parse(String(raw || "")) } catch (e) { parsed = null }
  if (!isPlainObject(parsed)) return state

  if (Array.isArray(parsed.tasks)) {
    for (var i = 0; i < parsed.tasks.length; i++) {
      var task = normalizeTask(parsed.tasks[i])
      if (task) state.tasks.push(task)
    }
  }
  state.currentTaskId = (typeof parsed.currentTaskId === "string") ? parsed.currentTaskId : ""
  if (state.currentTaskId !== "" && !hasTask(state.tasks, state.currentTaskId)) state.currentTaskId = ""
  state.phase = normalizePhase(parsed.phase)
  state.running = parsed.running === true
  state.deadlineMs = Math.max(0, finiteOr(parsed.deadlineMs, 0))
  state.pausedMs = Math.max(0, finiteOr(parsed.pausedMs, 0))
  state.cycleBlocks = Math.max(0, Math.floor(finiteOr(parsed.cycleBlocks, 0)))
  state.todayBlocks = Math.max(0, Math.floor(finiteOr(parsed.todayBlocks, 0)))
  state.todayKey = (typeof parsed.todayKey === "string") ? parsed.todayKey : ""
  state.history = sanitizeHistory(parsed.history)
  state.currentStreak = Math.max(0, Math.floor(finiteOr(parsed.currentStreak, 0)))
  state.bestStreak = Math.max(0, Math.floor(finiteOr(parsed.bestStreak, 0)))
  state.lastCountedDay = (typeof parsed.lastCountedDay === "string") ? parsed.lastCountedDay : ""
  state.notifyId = Math.max(0, Math.floor(finiteOr(parsed.notifyId, 0)))
  if (state.bestStreak < state.currentStreak) state.bestStreak = state.currentStreak
  return state
}

function serializeState(state) {
  var s = state || emptyState()
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

// Move today's counter onto the current local day. History is untouched:
// yesterday's count stays in the record.
function rollDay(state, epochMs) {
  var today = dayKey(epochMs)
  if (state.todayKey === today) return state
  var out = Object.assign({}, state)
  out.todayKey = today
  out.todayBlocks = 0
  return out
}

// One naturally completed work block: bumps today's count, writes history,
// and continues or restarts the streak. Hard reset is deliberate — the
// captain ruled out pause/freeze affordances, so a missed day restarts at 1.
function applyWorkBlockCompleted(state, epochMs) {
  var out = rollDay(state, epochMs)
  out = Object.assign({}, out)
  out.todayBlocks = out.todayBlocks + 1
  var history = Object.assign({}, out.history)
  history[out.todayKey] = out.todayBlocks
  out.history = history

  if (out.lastCountedDay === out.todayKey) {
    // Already counted today; keep the streak as it stands.
  } else if (out.lastCountedDay !== "" && out.lastCountedDay === previousDayKey(out.todayKey)) {
    out.currentStreak = out.currentStreak + 1
  } else {
    out.currentStreak = 1
  }
  out.lastCountedDay = out.todayKey
  if (out.currentStreak > out.bestStreak) out.bestStreak = out.currentStreak
  return out
}

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
    DEFAULT_SETTINGS: DEFAULT_SETTINGS,
    GLYPHS: GLYPHS,
    STATE_VERSION: STATE_VERSION,
    isPlainObject: isPlainObject,
    pad2: pad2,
    clampInt: clampInt,
    normalizePhase: normalizePhase,
    isBreakPhase: isBreakPhase,
    phaseGlyph: phaseGlyph,
    phaseLabel: phaseLabel,
    phaseMinutes: phaseMinutes,
    phaseLengthMs: phaseLengthMs,
    longBreakEvery: longBreakEvery,
    nextPhaseAfterWork: nextPhaseAfterWork,
    cyclePosition: cyclePosition,
    progressFraction: progressFraction,
    formatMs: formatMs,
    dayKey: dayKey,
    shiftDayKey: shiftDayKey,
    previousDayKey: previousDayKey,
    newTaskId: newTaskId,
    normalizeTask: normalizeTask,
    hasTask: hasTask,
    creditCurrentTask: creditCurrentTask,
    nextIncompleteTaskId: nextIncompleteTaskId,
    emptyState: emptyState,
    parseState: parseState,
    serializeState: serializeState,
    rollDay: rollDay,
    applyWorkBlockCompleted: applyWorkBlockCompleted,
    displayStreak: displayStreak,
    recentDays: recentDays,
    normalizeSettings: normalizeSettings
  }
}
