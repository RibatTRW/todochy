// Tests for the derived-view seam.
//
// The engine derives the displayed streak from the day key its own ticker rolls
// (`Engine.qml`, `todayKey`), not from the wall clock, so the binding does not
// re-evaluate four times a second. That day-key rule must stay identical to the
// clock-based `displayStreak` the rest of the code and the tests use, so these
// tests pin the two together and pin the day-rollover edge itself.

import { test } from "node:test"
import assert from "node:assert/strict"
import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const Model = require("../Model.js")

const DAY = 24 * 60 * 60 * 1000
// Local noon avoids any timezone edge at the day boundary.
function noon(y, m, d) {
  return new Date(y, m - 1, d, 12, 0, 0, 0).getTime()
}

test("displayStreakOnDay agrees with displayStreak for every day offset", () => {
  const today = noon(2026, 9, 15)
  const todayKey = Model.dayKey(today)
  for (const offset of [0, 1, 2, 5, 40]) {
    const lastCountedDay = Model.dayKey(today - offset * DAY)
    const state = { currentStreak: 7, lastCountedDay }
    assert.equal(
      Model.displayStreakOnDay(7, lastCountedDay, todayKey),
      Model.displayStreak(state, today),
      `day offset ${offset}`
    )
  }
})

test("displayStreakOnDay keeps a streak through yesterday and breaks it older", () => {
  const todayKey = "2026-09-15"
  assert.equal(Model.displayStreakOnDay(7, "2026-09-15", todayKey), 7)
  assert.equal(Model.displayStreakOnDay(7, "2026-09-14", todayKey), 7)
  assert.equal(Model.displayStreakOnDay(7, "2026-09-13", todayKey), 0)
  assert.equal(Model.displayStreakOnDay(0, "", todayKey), 0)
})
