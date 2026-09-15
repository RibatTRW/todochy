// Unit tests for Model.js — the pure helpers that are not the block lifecycle.
//
// Run with:  node --test test/*.test.mjs
//
// These are plain node tests with no QML runtime. Model.js holds settings
// clamping, phase lengths, formatting, calendar days, streak arithmetic and the
// task rules; the lifecycle that composes them (arming, phases, the settings
// change mid-block, the catch-up window, the completion consequence chain and
// the state file) is tested through Block.js in test/block.test.mjs, and the
// whole seam is pinned against the pre-refactor engine in
// test/equivalence.test.mjs.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const Model = require("../Model.js")

// Local noon avoids any timezone edge at the day boundary.
function noon(y, m, d) {
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime()
}

test("the interface stays narrow: every export has a caller", () => {
  // The refactor that introduced Block.js narrowed Model's interface from 35
  // exports to 17. Two features deliberately added to it: the alarm sound rules
  // (Engine.qml reads the settings, Alarm.qml the playback rules) and the
  // derived-view work's `displayStreakOnDay`, the day-key form of the streak
  // rule, so Engine.qml can derive the displayed streak from the day its
  // reducer rolls instead of reading the clock on every 250 ms tick.
  // `displayStreak` stays as the clock-based rule the tests and Block.js use.
  // Adding anything beyond these should be a deliberate decision.
  assert.deepEqual(Object.keys(Model).sort(), [
    "DEFAULT_SOUND_SETTINGS",
    "GLYPHS",
    "SOUND_CHOICES",
    "SOUND_DURATIONS_MS",
    "SOUND_GAP_MS",
    "alarmPlays",
    "alarmRepeatIntervalMs",
    "alarmTier",
    "creditCurrentTask",
    "currentTaskIdAfterAdd",
    "dayKey",
    "displayStreak",
    "displayStreakOnDay",
    "fallbackCommand",
    "fileUrlToPath",
    "formatMs",
    "hasTask",
    "isBreakPhase",
    "isKnownSoundId",
    "nextIncompleteTaskId",
    "normalizeSettings",
    "normalizeSoundSettings",
    "normalizeTask",
    "phaseGlyph",
    "phaseLabel",
    "phaseLengthMs",
    "previousDayKey",
    "progressFraction",
    "recentDays",
    "soundDurationMs",
    "soundForEvent",
    "soundIdOr",
    "soundVolumeScale",
    "tolerantBool"
  ])
})

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
  assert.equal(Model.phaseLengthMs(s, "work"), 25 * 60 * 1000)
  assert.equal(Model.phaseLengthMs(s, "short"), 5 * 60 * 1000)
  assert.equal(Model.phaseLengthMs(s, "long"), 15 * 60 * 1000)
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
  assert.equal(Model.phaseLengthMs(s, "work"), 25 * 60 * 1000)
  assert.equal(Model.phaseLengthMs(s, "short"), 60 * 1000)
  assert.equal(Model.phaseLengthMs(s, "long"), 600 * 60 * 1000)
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
  // Anything unrecognised renders as work, the same way every other phase
  // accessor falls back.
  assert.equal(Model.phaseGlyph("sideways"), Model.GLYPHS.work)
  assert.equal(Model.phaseLabel("sideways"), "Focus")
  assert.equal(Model.isBreakPhase("sideways"), false)
  assert.equal(Model.isBreakPhase("long"), true)
})

test("dayKey names the local calendar day, and previousDayKey steps back one", () => {
  assert.equal(Model.dayKey(noon(2026, 9, 14)), "2026-09-14")
  assert.equal(Model.dayKey(noon(2024, 2, 29)), "2024-02-29")
  assert.equal(Model.previousDayKey("2026-09-14"), "2026-09-13")
  assert.equal(Model.previousDayKey("2026-01-01"), "2025-12-31")
  assert.equal(Model.previousDayKey("2026-03-01"), "2026-02-28")
  assert.equal(Model.previousDayKey("nonsense"), "")
})

test("displayStreak keeps a streak alive through the day after the last block", () => {
  const state = { lastCountedDay: "2026-09-13", currentStreak: 4 }
  // Same day and the next day: still alive.
  assert.equal(Model.displayStreak(state, noon(2026, 9, 13)), 4)
  assert.equal(Model.displayStreak(state, noon(2026, 9, 14)), 4)
  // Two days later the chain is broken and the pill/panel must show 0.
  assert.equal(Model.displayStreak(state, noon(2026, 9, 15)), 0)
  // Nothing counted yet.
  assert.equal(Model.displayStreak({ lastCountedDay: "", currentStreak: 0 }, noon(2026, 9, 14)), 0)
})

test("recentDays reports the last N local days ending today", () => {
  const state = { history: { "2026-09-14": 1, "2026-09-12": 3 } }
  const days = Model.recentDays(state, noon(2026, 9, 14), 4)
  assert.equal(days.length, 4)
  assert.deepEqual(days.map((d) => d.key), ["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"])
  assert.deepEqual(days.map((d) => d.hit), [false, true, false, true])
  assert.equal(days[3].today, true)
  assert.equal(days[3].count, 1)
  assert.equal(days[1].count, 3)
  // A state with no history at all is fourteen empty days, not a crash.
  assert.equal(Model.recentDays({}, noon(2026, 9, 14), 14).length, 14)
  assert.equal(Model.recentDays(null, noon(2026, 9, 14), 14)[0].hit, false)
})

test("normalizeTask rejects blank rows and clamps the rest", () => {
  assert.equal(Model.normalizeTask({ text: "   " }), null)
  assert.equal(Model.normalizeTask({ text: "\n\t" }), null)
  assert.equal(Model.normalizeTask(null), null)
  assert.equal(Model.normalizeTask("plain string"), null)
  const task = Model.normalizeTask({ id: "tA", text: "  padded  ", done: 1, pomos: -3 })
  assert.deepEqual(task, { id: "tA", text: "  padded  ", done: false, pomos: 0 })
  // A row with no id gets one.
  const generated = Model.normalizeTask({ text: "fresh" })
  assert.equal(typeof generated.id, "string")
  assert.ok(generated.id.length > 1)
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

test("hasTask answers only for ids that are present", () => {
  const tasks = [{ id: "a", text: "one", done: false, pomos: 0 }]
  assert.equal(Model.hasTask(tasks, "a"), true)
  assert.equal(Model.hasTask(tasks, ""), false)
  assert.equal(Model.hasTask([], "a"), false)
})

test("adding a task takes the cursor only when the current task is done", () => {
  const open = [{ id: "a", text: "current", done: false, pomos: 0 }]
  assert.equal(Model.currentTaskIdAfterAdd(open, "a", "b"), "a")
  assert.equal(Model.currentTaskIdAfterAdd([], "", "b"), "b")
  assert.equal(Model.currentTaskIdAfterAdd([{ id: "a", text: "done", done: true, pomos: 0 }], "a", "b"), "b")
  // A dangling current id is not found, so the new task takes the cursor.
  assert.equal(Model.currentTaskIdAfterAdd(open, "missing", "b"), "b")
})

test("a task added after its predecessor is done receives the next completed block", () => {
  const done = { id: "a", text: "finished", done: true, pomos: 1 }
  const fresh = { id: "b", text: "next", done: false, pomos: 0 }
  const current = Model.currentTaskIdAfterAdd([done], "a", "b")
  assert.equal(current, "b")
  const credited = Model.creditCurrentTask([done, fresh], current)
  assert.equal(credited[0].pomos, 1)
  assert.equal(credited[1].pomos, 1)
})
// ---------------------------------------------------------------- sound
// The alarm: two events, two bundled sounds, a volume, and a repeat. These are
// the rules behind the captain's picks, so they are tested rather than trusted.

test("sound defaults are the captain's choices: on, two different sounds, twice, 55", () => {
  assert.deepEqual(Model.normalizeSoundSettings({}), {
    soundEnabled: true,
    soundSameForBoth: false,
    soundBlockEnd: "block-chime-clean",
    soundTaskDone: "task-two-note",
    soundRepeat: 2,
    soundVolume: 55
  })
})

test('a boolean written as the string "false" stays false', () => {
  const s = Model.normalizeSoundSettings({ soundEnabled: "false", soundSameForBoth: "false" })
  assert.equal(s.soundEnabled, false)
  assert.equal(s.soundSameForBoth, false)
  assert.equal(Model.normalizeSoundSettings({ soundEnabled: "true" }).soundEnabled, true)
  assert.equal(Model.normalizeSoundSettings({ soundEnabled: "off" }).soundEnabled, false)
  assert.equal(Model.normalizeSoundSettings({ soundEnabled: "on" }).soundEnabled, true)
  assert.equal(Model.normalizeSoundSettings({ soundEnabled: 0 }).soundEnabled, false)
  assert.equal(Model.normalizeSoundSettings({ soundEnabled: true }).soundEnabled, true)
  // Nonsense falls back rather than flipping a setting by accident.
  assert.equal(Model.normalizeSoundSettings({ soundEnabled: "maybe" }).soundEnabled, true)
  assert.equal(Model.normalizeSoundSettings({ soundEnabled: null }).soundEnabled, true)
})

test("a sound the plugin does not ship falls back to the bundled one", () => {
  const s = Model.normalizeSoundSettings({ soundBlockEnd: "block-deep-gong", soundTaskDone: 7 })
  assert.equal(s.soundBlockEnd, "block-chime-clean")
  assert.equal(s.soundTaskDone, "task-two-note")
  assert.equal(Model.isKnownSoundId("task-two-note"), true)
  assert.equal(Model.isKnownSoundId("block-deep-gong"), false)
})

test("repeat and volume are clamped into range", () => {
  assert.equal(Model.normalizeSoundSettings({ soundRepeat: 0 }).soundRepeat, 1)
  assert.equal(Model.normalizeSoundSettings({ soundRepeat: 9 }).soundRepeat, 3)
  assert.equal(Model.normalizeSoundSettings({ soundRepeat: "3" }).soundRepeat, 3)
  assert.equal(Model.normalizeSoundSettings({ soundRepeat: "twice" }).soundRepeat, 2)
  assert.equal(Model.normalizeSoundSettings({ soundVolume: -20 }).soundVolume, 0)
  assert.equal(Model.normalizeSoundSettings({ soundVolume: 500 }).soundVolume, 100)
  assert.equal(Model.normalizeSoundSettings({ soundVolume: "70" }).soundVolume, 70)
})

test("each event picks its own sound unless the user asks for one", () => {
  const separate = { soundBlockEnd: "block-chime-clean", soundTaskDone: "task-two-note" }
  assert.equal(Model.soundForEvent(separate, "block"), "block-chime-clean")
  assert.equal(Model.soundForEvent(separate, "task"), "task-two-note")
  const same = { soundBlockEnd: "task-two-note", soundTaskDone: "block-chime-clean", soundSameForBoth: true }
  assert.equal(Model.soundForEvent(same, "block"), "task-two-note")
  assert.equal(Model.soundForEvent(same, "task"), "task-two-note")
  assert.equal(Model.soundForEvent({}, "block"), "block-chime-clean")
})

test("the volume setting is a 0-100 number mapped onto the player's 0-1", () => {
  assert.equal(Model.soundVolumeScale(0), 0)
  assert.equal(Model.soundVolumeScale(55), 0.55)
  assert.equal(Model.soundVolumeScale(100), 1)
  assert.equal(Model.soundVolumeScale(150), 1)
  assert.equal(Model.soundVolumeScale(-5), 0)
  assert.equal(Model.soundVolumeScale("70"), 0.7)
  assert.equal(Model.soundVolumeScale(undefined), 0.55)
})

test("an alarm plays one to three times and defaults to twice", () => {
  assert.equal(Model.alarmPlays(2), 2)
  assert.equal(Model.alarmPlays(1), 1)
  assert.equal(Model.alarmPlays(3), 3)
  assert.equal(Model.alarmPlays(0), 1)
  assert.equal(Model.alarmPlays(99), 3)
  assert.equal(Model.alarmPlays(undefined), 2)
})

test("the repeat waits for the whole sound plus the gap, per bundled file", () => {
  assert.equal(Model.soundDurationMs("block-chime-clean"), 1550)
  assert.equal(Model.soundDurationMs("task-two-note"), 780)
  assert.equal(Model.soundDurationMs("not-a-sound"), 0)
  assert.equal(Model.alarmRepeatIntervalMs(1550, Model.SOUND_GAP_MS), 1900)
  assert.equal(Model.alarmRepeatIntervalMs(780, Model.SOUND_GAP_MS), 1130)
  // A missing duration still leaves a gap rather than firing back to back.
  assert.equal(Model.alarmRepeatIntervalMs(0, 300), 300)
})

test("playback prefers the in-process player and falls back, then goes quiet", () => {
  assert.equal(Model.alarmTier(true, "/usr/bin/pw-play"), "in-process")
  assert.equal(Model.alarmTier(false, "/usr/bin/pw-play"), "external")
  assert.equal(Model.alarmTier(false, ""), "silent")
  assert.equal(Model.alarmTier(false, undefined), "silent")
})

test("the external fallback passes each player the volume flag it understands", () => {
  const wav = "/tmp/block-chime-clean.wav"
  assert.deepEqual(Model.fallbackCommand("/usr/bin/mpv", 55, wav),
    ["/usr/bin/mpv", "--no-video", "--really-quiet", "--volume=55", wav])
  assert.deepEqual(Model.fallbackCommand("/usr/bin/pw-play", 55, wav),
    ["/usr/bin/pw-play", "--volume=0.55", wav])
  assert.deepEqual(Model.fallbackCommand("/usr/bin/paplay", 100, wav),
    ["/usr/bin/paplay", "--volume=65536", wav])
  assert.deepEqual(Model.fallbackCommand("/usr/bin/ffplay", 55, wav),
    ["/usr/bin/ffplay", "-nodisp", "-autoexit", "-loglevel", "quiet", wav])
  assert.deepEqual(Model.fallbackCommand("/usr/bin/canberra-gtk-play", 55, wav),
    ["/usr/bin/canberra-gtk-play", "-f", wav])
  assert.deepEqual(Model.fallbackCommand("/usr/bin/aplay", 55, wav), ["/usr/bin/aplay", "-q", wav])
  // No player, or no file: nothing to run.
  assert.deepEqual(Model.fallbackCommand("", 55, wav), [])
  assert.deepEqual(Model.fallbackCommand("/usr/bin/mpv", 55, ""), [])
})

test("a file:// asset URL becomes a path the external players can open", () => {
  assert.equal(Model.fileUrlToPath("file:///home/u/.config/omarchy/plugins/x/assets/sounds/a.wav"),
    "/home/u/.config/omarchy/plugins/x/assets/sounds/a.wav")
  assert.equal(Model.fileUrlToPath("file:///tmp/my%20sounds/a.wav"), "/tmp/my sounds/a.wav")
  assert.equal(Model.fileUrlToPath("/already/a/path.wav"), "/already/a/path.wav")
  assert.equal(Model.fileUrlToPath(""), "")
})
