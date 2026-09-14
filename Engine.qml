import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model
import "Block.js" as Block

// Todochy's engine: the adapter around the block lifecycle.
//
// Block.js owns what a block does — arming a phase length, the three phases, a
// settings change arriving mid-block, the six-hour catch-up window, and the
// whole consequence chain of a finished work block. This file owns the shell's
// side of that: the ticker that hands the reducer a clock reading, the FileView
// that reads and writes state.json, the notification process, the widget's
// settings entry, and the projection of the block value onto the properties
// Panel.qml and BarWidget.qml bind to.
//
// It lives on the bar widget rather than inside Panel.qml because the countdown
// has to keep running while the panel is closed, and because the bar surface
// exists per monitor — one engine drives every surface of this widget.
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

  // ------------------------------------------------------------------ block

  // The block value *is* the state; every property below it is a read-only view
  // for the pill and the panel. Only `dispatch` and the task functions write it,
  // and the reducer is the one owner of the rules those writes obey.
  property var block: Block.empty()

  readonly property var tasks: block.tasks
  readonly property string currentTaskId: block.currentTaskId
  readonly property string phase: block.phase
  readonly property bool running: block.running === true
  readonly property int todayBlocks: block.todayBlocks
  readonly property int cycleBlocks: block.cycleBlocks
  readonly property int notifyId: block.notifyId
  readonly property bool hasCurrentTask: currentTaskId !== ""

  // Wall clock, refreshed on every dispatch. Bindings read this rather than
  // calling Date.now() so a paused engine does not re-evaluate on every frame.
  property double nowMs: Date.now()

  readonly property double remainingMs: Block.remainingMs(block, nowMs)
  readonly property double phaseTotalMs: Model.phaseLengthMs(effectiveSettings, phase)
  readonly property real progress: Model.progressFraction(remainingMs, phaseTotalMs)
  readonly property bool runningOut: running && remainingMs > 0 && remainingMs <= 60 * 1000
  readonly property string displayTime: Model.formatMs(remainingMs)
  readonly property string phaseGlyph: Model.phaseGlyph(phase)
  readonly property string phaseLabel: Model.phaseLabel(phase)
  readonly property bool onBreak: Model.isBreakPhase(phase)
  readonly property int cyclePos: Block.cyclePosition(cycleBlocks, longBreakEvery)
  readonly property int streak: Model.displayStreak(block, nowMs)

  // The state file is only read once the widget has been told to arm itself;
  // before that a settings change has nothing to re-arm.
  property bool ready: false
  property bool dirReady: false

  // Recent days for the panel strip. Deliberately does not read `nowMs`, so the
  // strip's binding does not churn four times a second.
  function recentDaysList(count) {
    return Model.recentDays(block, Date.now(), count)
  }

  // ------------------------------------------------------------------- seam

  // The single entry point to the lifecycle: hand the block an event and a
  // reading of the clock, take the next block, perform the effects it asked
  // for.
  function dispatch(event) {
    var now = Date.now()
    nowMs = now
    var result = Block.reduce(block, event, { now: now, settings: effectiveSettings })
    block = result.block
    performEffects(result.effects)
    return result
  }

  function performEffects(effects) {
    for (var i = 0; i < effects.length; i++) {
      var effect = effects[i]
      if (effect.kind === "persist") save()
      else if (effect.kind === "notify") notifyBlockEnd(effect.phase)
      // "credit" needs no adapter work: the reducer already applied it to the
      // block's tasks. It rides along as the observable record of the
      // completion chain.
    }
  }

  // A settings change reaches this widget from two places — the panel's fields
  // and `omarchy bar set` / an edited shell.json — and both arrive the same
  // way: this value changes. The reducer is the single owner of what that means
  // for an idle, a paused and a running block, so the two paths cannot drift
  // apart.
  onEffectiveSettingsChanged: if (ready) dispatch({ type: "SETTINGS_CHANGED" })

  // ---------------------------------------------------------------- ticker

  property Timer ticker: Timer {
    id: ticker
    interval: 250
    repeat: true
    running: true
    onTriggered: engine.dispatch({ type: "TICK" })
  }

  function start() { dispatch({ type: "START" }) }
  function pause() { dispatch({ type: "PAUSE" }) }
  function toggleRunning() { dispatch({ type: running ? "PAUSE" : "START" }) }
  function skip() { dispatch({ type: "SKIP" }) }
  function resetBlock() { dispatch({ type: "RESET" }) }

  // ------------------------------------------------------------------ tasks

  // Task CRUD is not the lifecycle: these are thin calls into Model.js's pure
  // task helpers over the block value, and the reducer owns everything that
  // happens to a task when a block ends.

  function commit(patch) {
    block = Object.assign({}, block, patch)
    save()
  }

  function addTask(text) {
    var value = String(text || "").trim()
    if (value === "") return
    var task = Model.normalizeTask({ text: value })
    if (!task) return
    commit({
      tasks: block.tasks.concat([task]),
      currentTaskId: Model.currentTaskIdAfterAdd(block.tasks, block.currentTaskId, task.id)
    })
  }

  function selectTask(id) {
    if (id === block.currentTaskId) return
    if (!Model.hasTask(block.tasks, id)) return
    commit({ currentTaskId: id })
  }

  function setTaskDone(id, done) {
    var next = []
    for (var i = 0; i < block.tasks.length; i++) {
      var t = block.tasks[i]
      if (t.id === id) next.push({ id: t.id, text: t.text, done: done === true, pomos: t.pomos })
      else next.push(t)
    }
    commit({ tasks: next })
  }

  function deleteTask(id) {
    var next = []
    for (var i = 0; i < block.tasks.length; i++) if (block.tasks[i].id !== id) next.push(block.tasks[i])
    var patch = { tasks: next }
    if (block.currentTaskId === id) patch.currentTaskId = Model.nextIncompleteTaskId(next, "")
    commit(patch)
  }

  // One click, three meanings: select an open task, complete the current one,
  // or reopen a completed one.
  function handleTaskClick(id) {
    var task = null
    for (var i = 0; i < block.tasks.length; i++) if (block.tasks[i].id === id) task = block.tasks[i]
    if (!task) return
    if (task.done) { setTaskDone(id, false); return }
    if (id === block.currentTaskId) { setTaskDone(id, true); return }
    selectTask(id)
  }

  // --------------------------------------------------------------- settings

  // Persist one interval override. The value rides on the widget's inline
  // shell.json entry, which is the only settings surface the shell gives a bar
  // widget; shell.json itself is never written directly. The re-arm this used
  // to do inline is gone on purpose — the settings value changing is the one
  // signal that drives it, exactly as it does for `omarchy bar set`.
  function setSetting(key, value) {
    if (!host) return
    var merged = { id: moduleName }
    var current = hostSettings || {}
    for (var k in current) if (k !== "id") merged[k] = current[k]
    merged[key] = value
    host.settings = merged
    if (host.bar && host.bar.shell && typeof host.bar.shell.updateEntryInline === "function")
      host.bar.shell.updateEntryInline(moduleName, merged)
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
    stateFile.setText(Block.serialize(block))
  }

  function loadState(raw) {
    ready = true
    dispatch({ type: "LOAD", raw: raw })
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
        if (isFinite(id) && id > 0) engine.dispatch({ type: "NOTIFY_SENT", id: id })
      }
    }
  }

  // One toast, replaced in place: -p captures the id the daemon assigned and
  // the next block's toast reuses it with -r, so a long session never stacks
  // notifications. The action button summons the panel so the toast is useful
  // without a trip to the bar.
  function notifyBlockEnd(phase) {
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

  Component.onCompleted: {
    // Block.js composes Model.js's rules, and QML can only hand it that
    // namespace at runtime: a `.import` directive inside a JS library is not
    // valid JavaScript, so Block.js is requirable by node instead and takes the
    // namespace from here.
    Block.bindModel(Model)
    mkdirProc.running = true
  }
}
