import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Todochy's engine: the timer, the task list, the streak, and the state file.
//
// It lives on the bar widget rather than inside Panel.qml because the countdown
// has to keep running while the panel is closed, and because the bar surface
// exists per monitor — one engine drives every surface of this widget.
//
// Every rule with a consequence (phase cadence, streak accounting, day
// rollover, state parsing) is delegated to Model.js, which is unit-tested in
// test/model.test.mjs. This file owns only timers, file IO and notifications.
//
// The countdown is derived from a wall-clock deadline rather than accumulated
// ticks, so suspending the machine or restarting the shell cannot skew it.

QtObject {
  id: engine

  // The BarWidget root. Provides `settings` (this widget's inline shell.json
  // entry), `bar` (the shell bar facade) and `moduleName`.
  required property var host

  readonly property string moduleName: host ? String(host.moduleName || "") : ""
  readonly property var hostSettings: (host && host.settings) ? host.settings : ({})

  // Clamped, defaulted view of the inline settings. The shell does not write
  // manifest defaults into shell.json, so every value needs its fallback here.
  readonly property var effectiveSettings: Model.normalizeSettings(hostSettings)
  readonly property int workMinutes: effectiveSettings.workMinutes
  readonly property int shortBreakMinutes: effectiveSettings.shortBreakMinutes
  readonly property int longBreakMinutes: effectiveSettings.longBreakMinutes
  readonly property int longBreakEvery: effectiveSettings.longBreakEvery

  // ------------------------------------------------------------------ state

  property var tasks: []
  property string currentTaskId: ""
  property string phase: "work"
  property bool running: false
  property double deadlineMs: 0
  property double pausedMs: 0
  property int cycleBlocks: 0
  property int todayBlocks: 0
  property string todayKey: ""
  property var history: ({})
  property int currentStreak: 0
  property int bestStreak: 0
  property string lastCountedDay: ""
  property int notifyId: 0

  // Wall clock, refreshed by the ticker. Bindings read this rather than
  // calling Date.now() so a paused engine does not re-evaluate on every frame.
  property double nowMs: Date.now()

  property bool ready: false
  property bool dirReady: false

  // A run that expired while the shell was down still completes, but only if it
  // expired recently: waking up a week later must not credit a week-old block.
  readonly property double maxCatchUpMs: 6 * 60 * 60 * 1000

  // --------------------------------------------------------------- derived

  readonly property double remainingMs: running ? Math.max(0, deadlineMs - nowMs) : Math.max(0, pausedMs)
  readonly property double phaseTotalMs: Model.phaseLengthMs(effectiveSettings, phase)
  readonly property real progress: Model.progressFraction(remainingMs, phaseTotalMs)
  readonly property bool runningOut: running && remainingMs > 0 && remainingMs <= 60 * 1000
  readonly property string displayTime: Model.formatMs(remainingMs)
  readonly property string phaseGlyph: Model.phaseGlyph(phase)
  readonly property string phaseLabel: Model.phaseLabel(phase)
  readonly property bool onBreak: Model.isBreakPhase(phase)
  readonly property int cyclePos: Model.cyclePosition(cycleBlocks, longBreakEvery)
  readonly property int streak: Model.displayStreak(snapshot(), nowMs)
  readonly property bool hasCurrentTask: currentTaskId !== ""

  function snapshot() {
    return {
      version: Model.STATE_VERSION,
      tasks: tasks,
      currentTaskId: currentTaskId,
      phase: phase,
      running: running,
      deadlineMs: deadlineMs,
      pausedMs: pausedMs,
      cycleBlocks: cycleBlocks,
      todayBlocks: todayBlocks,
      todayKey: todayKey,
      history: history,
      currentStreak: currentStreak,
      bestStreak: bestStreak,
      lastCountedDay: lastCountedDay,
      notifyId: notifyId
    }
  }

  function applyState(state) {
    tasks = state.tasks
    currentTaskId = state.currentTaskId
    phase = state.phase
    running = state.running
    deadlineMs = state.deadlineMs
    pausedMs = state.pausedMs
    cycleBlocks = state.cycleBlocks
    todayBlocks = state.todayBlocks
    todayKey = state.todayKey
    history = state.history
    currentStreak = state.currentStreak
    bestStreak = state.bestStreak
    lastCountedDay = state.lastCountedDay
    notifyId = state.notifyId
  }

  // Recent days for the panel strip. Deliberately does not read `nowMs`, so the
  // strip's binding does not churn four times a second.
  function recentDaysList(count) {
    return Model.recentDays(snapshot(), Date.now(), count)
  }

  // ---------------------------------------------------------------- ticker

  property Timer ticker: Timer {
    interval: 250
    repeat: true
    running: true
    onTriggered: engine.tick()
  }

  function tick() {
    nowMs = Date.now()
    if (running && deadlineMs - nowMs <= 0) {
      completeBlock(true)
      return
    }
    // Roll the day at midnight even when nothing is running, so "today" never
    // shows yesterday's count.
    var today = Model.dayKey(nowMs)
    if (todayKey !== today) {
      todayKey = today
      todayBlocks = 0
      save()
    }
  }

  // ----------------------------------------------------------------- phases

  function start() {
    if (running) return
    var remaining = remainingMs
    if (remaining <= 0) remaining = Model.phaseLengthMs(effectiveSettings, phase)
    pausedMs = remaining
    deadlineMs = Date.now() + remaining
    nowMs = Date.now()
    running = true
    save()
  }

  function pause() {
    if (!running) return
    pausedMs = Math.max(0, deadlineMs - Date.now())
    running = false
    deadlineMs = 0
    nowMs = Date.now()
    save()
  }

  function toggleRunning() {
    if (running) pause()
    else start()
  }

  // Skipping never counts: no work-block credit, no streak movement, no
  // pomodoro on the task. It only moves the cadence on.
  function skip() {
    completeBlock(false)
  }

  function resetBlock() {
    running = false
    deadlineMs = 0
    pausedMs = Model.phaseLengthMs(effectiveSettings, phase)
    nowMs = Date.now()
    save()
  }

  function completeBlock(natural) {
    var now = Date.now()
    var wasWork = phase === "work"

    if (wasWork) {
      if (natural) {
        var next = Model.applyWorkBlockCompleted(snapshot(), now)
        next.cycleBlocks = cycleBlocks + 1
        next.tasks = Model.creditCurrentTask(tasks, currentTaskId)
        applyState(next)
        advanceCurrentTask()
      }
      phase = Model.nextPhaseAfterWork(cycleBlocks, longBreakEvery)
    } else {
      phase = "work"
    }

    running = false
    deadlineMs = 0
    pausedMs = Model.phaseLengthMs(effectiveSettings, phase)
    nowMs = now
    if (natural) notifyBlockEnd()
    save()
  }

  // The captain's rule: a finished block moves the cursor only when the task it
  // was working on had been marked complete during the block. Otherwise the
  // task stays current.
  function advanceCurrentTask() {
    var current = null
    for (var i = 0; i < tasks.length; i++) if (tasks[i].id === currentTaskId) current = tasks[i]
    if (!current || !current.done) return
    var nextId = Model.nextIncompleteTaskId(tasks, "")
    if (nextId !== "") currentTaskId = nextId
  }

  // ------------------------------------------------------------------ tasks

  function addTask(text) {
    var value = String(text || "").trim()
    if (value === "") return
    var next = snapshot()
    var task = Model.normalizeTask({ text: value })
    if (!task) return
    next.tasks = tasks.concat([task])
    next.currentTaskId = Model.currentTaskIdAfterAdd(tasks, currentTaskId, task.id)
    applyState(next)
    save()
  }

  function selectTask(id) {
    if (id === currentTaskId) return
    if (!Model.hasTask(tasks, id)) return
    currentTaskId = id
    save()
  }

  function setTaskDone(id, done) {
    var next = []
    for (var i = 0; i < tasks.length; i++) {
      var t = tasks[i]
      if (t.id === id) next.push({ id: t.id, text: t.text, done: done === true, pomos: t.pomos })
      else next.push(t)
    }
    tasks = next
    save()
  }

  function deleteTask(id) {
    var next = []
    for (var i = 0; i < tasks.length; i++) if (tasks[i].id !== id) next.push(tasks[i])
    tasks = next
    if (currentTaskId === id) {
      var replacement = Model.nextIncompleteTaskId(tasks, "")
      currentTaskId = replacement
    }
    save()
  }

  // One click, three meanings: select an open task, complete the current one,
  // or reopen a completed one.
  function handleTaskClick(id) {
    var task = null
    for (var i = 0; i < tasks.length; i++) if (tasks[i].id === id) task = tasks[i]
    if (!task) return
    if (task.done) { setTaskDone(id, false); return }
    if (id === currentTaskId) { setTaskDone(id, true); return }
    selectTask(id)
  }

  // --------------------------------------------------------------- settings

  // Persist one interval override. The value rides on the widget's inline
  // shell.json entry, which is the only settings surface the shell gives a bar
  // widget; shell.json itself is never written directly.
  function setSetting(key, value) {
    if (!host) return
    var merged = { id: moduleName }
    var current = hostSettings || {}
    for (var k in current) if (k !== "id") merged[k] = current[k]
    merged[key] = value
    host.settings = merged
    if (host.bar && host.bar.shell && typeof host.bar.shell.updateEntryInline === "function")
      host.bar.shell.updateEntryInline(moduleName, merged)
    if (!running && !(pausedMs > 0)) {
      pausedMs = Model.phaseLengthMs(effectiveSettings, phase)
      nowMs = Date.now()
    }
    save()
  }

  // ------------------------------------------------------------------- disk

  readonly property string stateHome: {
    var override = Quickshell.env("XDG_STATE_HOME")
    if (override && override.length > 0) return override
    return Quickshell.env("HOME") + "/.local/state"
  }
  readonly property string stateDir: stateHome + "/omarchy/todochy"
  readonly property string statePath: stateDir + "/state.json"

  property FileView stateFile: FileView {
    id: stateFile
    path: engine.statePath
    watchChanges: false
    atomicWrites: true
    printErrors: false
    onLoaded: engine.loadState(text())
    onLoadFailed: engine.loadState("")
  }

  property Process mkdirProc: Process {
    id: mkdirProc
    command: ["mkdir", "-p", engine.stateDir]
    onExited: function(exitCode) {
      engine.dirReady = true
      stateFile.reload()
    }
  }

  function save() {
    if (!dirReady) return
    stateFile.setText(Model.serializeState(snapshot()))
  }

  function loadState(raw) {
    var state = Model.parseState(raw)
    applyState(state)
    var now = Date.now()
    nowMs = now

    var today = Model.dayKey(now)
    if (todayKey !== today) {
      todayKey = today
      todayBlocks = 0
    }

    if (running && deadlineMs > 0) {
      if (deadlineMs <= now) {
        // The block expired while the shell was down. Complete it if that was
        // recent, otherwise treat the session as abandoned.
        if (now - deadlineMs <= maxCatchUpMs) {
          ready = true
          completeBlock(true)
          return
        }
        running = false
        deadlineMs = 0
        pausedMs = Model.phaseLengthMs(effectiveSettings, phase)
      }
    } else {
      running = false
      deadlineMs = 0
      if (pausedMs <= 0) pausedMs = Model.phaseLengthMs(effectiveSettings, phase)
    }

    ready = true
    save()
  }

  // ------------------------------------------------------------------ notify

  property var notifyCommand: []

  property Process notifyProc: Process {
    id: notifyProc
    command: engine.notifyCommand
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: {
        var id = parseInt(String(text || "").trim(), 10)
        if (isFinite(id) && id > 0) {
          engine.notifyId = id
          // Persist immediately: otherwise the id lives only in memory and a
          // shell restart would send a fresh toast instead of replacing the
          // previous block's one.
          engine.save()
        }
      }
    }
  }

  // One toast, replaced in place: -p captures the id the daemon assigned and
  // the next block's toast reuses it with -r, so a long session never stacks
  // notifications. The action button summons the panel so the toast is useful
  // without a trip to the bar.
  function notifyBlockEnd() {
    var title = phase === "work" ? "Break over" : (phase === "long" ? "Long break" : "Short break")
    var body = phase === "work"
      ? "Back to focus."
      : (phase === "long" ? "Time for a long break." : "Time for a short break.")
    var cmd = ["omarchy-notification-send", "--app-name", "todochy", "-u", "normal",
               "-g", Model.phaseGlyph(phase)]
    if (notifyId > 0) cmd.push("-r", String(notifyId))
    cmd.push("-p", title, body)
    if (moduleName !== "") cmd.push("--exec", "omarchy-shell", "shell", "toggle", moduleName, "{}")
    notifyCommand = cmd
    notifyProc.running = true
  }

  Component.onCompleted: mkdirProc.running = true
}
