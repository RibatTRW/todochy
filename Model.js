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

// The streak rule, resolved against a day the caller already knows. A surface
// that tracks the day itself (the engine's ticker rolls `todayKey`) derives the
// streak through this without reading the clock, so the value recomputes only
// when the counters or the day move — not on every 250 ms tick.
function displayStreakOnDay(currentStreak, lastCountedDay, todayKey) {
  if (lastCountedDay === todayKey) return currentStreak
  if (lastCountedDay === previousDayKey(todayKey)) return currentStreak
  return 0
}

// What the user should see. A streak stays alive through today when the last
// counted day was yesterday; anything older means the chain is broken.
function displayStreak(state, epochMs) {
  return displayStreakOnDay(state.currentStreak, state.lastCountedDay, dayKey(epochMs))
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

// ------------------------------------------------------------------ sound

// The alarm fires on two events and no others: a work block ending and a task
// being marked complete. Everything about it is a setting, so these are the
// values a missing or hand-edited shell.json entry falls back to.
var DEFAULT_SOUND_SETTINGS = {
  soundEnabled: true,
  soundSameForBoth: false,
  soundBlockEnd: "block-chime-clean",
  soundTaskDone: "task-two-note",
  soundRepeat: 2,
  soundVolume: 55
}

// The sounds bundled in assets/sounds/. Both are original synthesised works
// that ship under this plugin's licence.
var SOUND_CHOICES = [
  { value: "block-chime-clean", label: "Chime (clean)" },
  { value: "task-two-note", label: "Two-note callback" }
]

// Measured lengths of the shipped files. They are what schedules the repeat:
// the next play waits for the whole sound plus the gap, so a repeat can never
// start on top of the one before it.
var SOUND_DURATIONS_MS = {
  "block-chime-clean": 1550,
  "task-two-note": 780
}

var SOUND_GAP_MS = 350
var MIN_ALARM_REPEAT = 1
var MAX_ALARM_REPEAT = 3
var MIN_ALARM_VOLUME = 0
var MAX_ALARM_VOLUME = 100

// Booleans arrive either typed (from the manifest defaults) or as strings (from
// the widget's inline shell.json entry), so `Boolean(value)` is wrong here:
// Boolean("false") is true. Only recognised spellings count; anything else is
// the fallback.
function tolerantBool(value, fallback) {
  if (value === true || value === false) return value
  if (typeof value === "number") {
    if (value === 1) return true
    if (value === 0) return false
    return fallback
  }
  if (typeof value === "string") {
    var v = value.trim().toLowerCase()
    if (v === "true" || v === "on" || v === "yes" || v === "1") return true
    if (v === "false" || v === "off" || v === "no" || v === "0") return false
  }
  return fallback
}

function isKnownSoundId(value) {
  for (var i = 0; i < SOUND_CHOICES.length; i++) {
    if (SOUND_CHOICES[i].value === value) return true
  }
  return false
}

// A sound the plugin does not ship is never played: a stale or hand-edited id
// falls back to the default rather than pointing a player at a missing file.
function soundIdOr(value, fallback) {
  return isKnownSoundId(value) ? value : fallback
}

function normalizeSoundSettings(values) {
  var v = isPlainObject(values) ? values : {}
  return {
    soundEnabled: tolerantBool(v.soundEnabled, DEFAULT_SOUND_SETTINGS.soundEnabled),
    soundSameForBoth: tolerantBool(v.soundSameForBoth, DEFAULT_SOUND_SETTINGS.soundSameForBoth),
    soundBlockEnd: soundIdOr(v.soundBlockEnd, DEFAULT_SOUND_SETTINGS.soundBlockEnd),
    soundTaskDone: soundIdOr(v.soundTaskDone, DEFAULT_SOUND_SETTINGS.soundTaskDone),
    soundRepeat: clampInt(v.soundRepeat, MIN_ALARM_REPEAT, MAX_ALARM_REPEAT, DEFAULT_SOUND_SETTINGS.soundRepeat),
    soundVolume: clampInt(v.soundVolume, MIN_ALARM_VOLUME, MAX_ALARM_VOLUME, DEFAULT_SOUND_SETTINGS.soundVolume)
  }
}

// Which bundled sound an event plays. `kind` is "block" for a work block
// ending or "task" for a task being marked complete. With soundSameForBoth the
// task event borrows the block sound, so the two can be made identical without
// a second choice.
function soundForEvent(settings, kind) {
  var s = normalizeSoundSettings(settings)
  if (kind !== "task") return s.soundBlockEnd
  return s.soundSameForBoth ? s.soundBlockEnd : s.soundTaskDone
}

// The 0-100 setting maps straight onto the player's 0-1 volume: the response is
// linear in amplitude, so no perceptual curve is needed on the way.
function soundVolumeScale(percent) {
  var n = Number(percent)
  if (!isFinite(n)) n = DEFAULT_SOUND_SETTINGS.soundVolume
  return clampInt(n, MIN_ALARM_VOLUME, MAX_ALARM_VOLUME, DEFAULT_SOUND_SETTINGS.soundVolume) / 100
}

// How many times one alarm plays. The captain asked to hear it twice; the cap
// keeps a hand-edited value from turning a block end into a siren.
function alarmPlays(repeat) {
  return clampInt(repeat, MIN_ALARM_REPEAT, MAX_ALARM_REPEAT, DEFAULT_SOUND_SETTINGS.soundRepeat)
}

function soundDurationMs(id) {
  var d = SOUND_DURATIONS_MS[id]
  return (typeof d === "number" && isFinite(d) && d > 0) ? d : 0
}

// The delay between two plays of one alarm: the sound's whole length plus the
// gap, so the second play follows the first rather than overlapping it.
function alarmRepeatIntervalMs(durationMs, gapMs) {
  var d = Math.max(0, finiteOr(durationMs, 0))
  var g = Math.max(0, finiteOr(gapMs, SOUND_GAP_MS))
  return d + g
}

// Playback tier: the in-process player first, an external player only when it
// is unavailable, and silence when neither exists.
function alarmTier(inProcessReady, externalPlayer) {
  if (inProcessReady) return "in-process"
  if (typeof externalPlayer === "string" && externalPlayer !== "") return "external"
  return "silent"
}

// A file:// URL as a filesystem path, for the external players, which take a
// path rather than a URL.
function fileUrlToPath(url) {
  var s = typeof url === "string" ? url : ""
  if (s.indexOf("file://") !== 0) return s
  var rest = s.slice("file://".length)
  try { return decodeURIComponent(rest) } catch (e) { return rest }
}

// The command for the external fallback. mpv, pw-play and paplay each spell
// their volume flag differently; ffplay, canberra-gtk-play and aplay take
// none, so the setting only scales the first three — except that volume 0
// mutes every player by returning no command.
function fallbackCommand(player, volume, path) {
  var p = typeof player === "string" ? player : ""
  var file = typeof path === "string" ? path : ""
  if (p === "" || file === "") return []
  var pct = clampInt(volume, MIN_ALARM_VOLUME, MAX_ALARM_VOLUME, DEFAULT_SOUND_SETTINGS.soundVolume)
  if (pct === 0) return []
  var v = pct / 100
  var name = p.split("/").pop()
  if (name === "mpv") return [p, "--no-video", "--really-quiet", "--volume=" + String(pct), file]
  if (name === "pw-play") return [p, "--volume=" + String(v), file]
  if (name === "paplay") return [p, "--volume=" + String(Math.round(v * 65536)), file]
  if (name === "ffplay") return [p, "-nodisp", "-autoexit", "-loglevel", "quiet", file]
  if (name === "canberra-gtk-play") return [p, "-f", file]
  if (name === "aplay") return [p, "-q", file]
  return [p, file]
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
    displayStreakOnDay: displayStreakOnDay,
    // Task rules. Task CRUD in Engine.qml and the completion chain in Block.js
    // both call these.
    normalizeTask: normalizeTask,
    hasTask: hasTask,
    creditCurrentTask: creditCurrentTask,
    currentTaskIdAfterAdd: currentTaskIdAfterAdd,
    nextIncompleteTaskId: nextIncompleteTaskId,
    // Alarm sound rules. Engine.qml and Alarm.qml read these.
    DEFAULT_SOUND_SETTINGS: DEFAULT_SOUND_SETTINGS,
    SOUND_CHOICES: SOUND_CHOICES,
    SOUND_DURATIONS_MS: SOUND_DURATIONS_MS,
    SOUND_GAP_MS: SOUND_GAP_MS,
    tolerantBool: tolerantBool,
    isKnownSoundId: isKnownSoundId,
    soundIdOr: soundIdOr,
    normalizeSoundSettings: normalizeSoundSettings,
    soundForEvent: soundForEvent,
    soundVolumeScale: soundVolumeScale,
    alarmPlays: alarmPlays,
    soundDurationMs: soundDurationMs,
    alarmRepeatIntervalMs: alarmRepeatIntervalMs,
    alarmTier: alarmTier,
    fileUrlToPath: fileUrlToPath,
    fallbackCommand: fallbackCommand
  }
}
