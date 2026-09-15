import QtQuick
import Quickshell
import Quickshell.Io
import "Model.js" as Model

// Todochy's alarm: the two audible events and nothing else. A work block
// ending rings; a task marked complete rings; starting, pausing, skipping,
// resetting, and a break ending are silent. Each alarm plays `repeat` times,
// one whole sound plus a short gap apart, so a repeat follows the sound it
// repeats instead of landing on top of it.
//
// Playback is two-tier. Tier 1 is SoundPlayer.qml — in-process, through the
// shell's own Qt Multimedia — and is what plays whenever it is available. Tier
// 2 shells out to the first external player that exists (mpv, then pw-play,
// paplay, ffplay, canberra-gtk-play, aplay), the same shape Omarchy's own
// battery-low hook uses. Tier 2 is reached only when the in-process player is
// unavailable. With neither, the alarm is silent: no player is ever awaited,
// so a block transition and a task click are unaffected either way.
//
// All of the arithmetic — which sound an event plays, the 0-100 volume, how
// many plays and at what spacing, the tier and the fallback command — lives in
// Model.js and is unit-tested in test/model.test.mjs. This file owns only the
// Loader, the probe, the timers and the two calls into the player.

QtObject {
  id: alarm

  property string assetDir: ""
  property bool enabled: Model.DEFAULT_SOUND_SETTINGS.soundEnabled
  property bool sameForBoth: Model.DEFAULT_SOUND_SETTINGS.soundSameForBoth
  property string blockSound: Model.DEFAULT_SOUND_SETTINGS.soundBlockEnd
  property string taskSound: Model.DEFAULT_SOUND_SETTINGS.soundTaskDone
  property int repeat: Model.DEFAULT_SOUND_SETTINGS.soundRepeat
  property int volumePercent: Model.DEFAULT_SOUND_SETTINGS.soundVolume

  readonly property real volume: Model.soundVolumeScale(volumePercent)
  readonly property var soundSettings: ({
    soundBlockEnd: blockSound,
    soundTaskDone: taskSound,
    soundSameForBoth: sameForBoth
  })

  // ------------------------------------------------ tier 1: in-process

  property Loader inProcess: Loader {
    source: Qt.resolvedUrl("SoundPlayer.qml")
    // The player is a file of its own, so it has to be handed the asset folder
    // and the settings. Bindings rather than one-off assignments: changing a
    // sound or the volume in the gear panel re-points the loaded player too.
    onLoaded: {
      if (!item) return
      item.assetDir = Qt.binding(function() { return alarm.assetDir })
      item.volume = Qt.binding(function() { return alarm.volume })
      item.blockSound = Qt.binding(function() { return alarm.blockSound })
      item.taskSound = Qt.binding(function() { return alarm.soundId("task") })
    }
  }

  readonly property bool inProcessReady: inProcess.status === Loader.Ready
    && inProcess.item !== null && inProcess.item.ready === true

  // ------------------------------------------------ tier 2: external player

  // Probed once, when the widget loads: nothing is spawned or waited for on a
  // block transition. An empty result means no player on this machine, which
  // is survivable — the alarm simply stays silent.
  property string externalPlayer: ""

  property Process playerProbe: Process {
    command: ["sh", "-c", "command -v mpv || command -v pw-play || command -v paplay"
      + " || command -v ffplay || command -v canberra-gtk-play || command -v aplay || true"]
    stdout: StdioCollector {
      waitForEnd: true
      onStreamFinished: alarm.externalPlayer = String(text || "").trim().split("\n")[0]
    }
  }

  // True whenever some player can be reached, in-process or external. The gear
  // panel uses it to say so instead of offering a control that does nothing.
  readonly property bool playerAvailable: inProcessReady || externalPlayer !== ""

  // --------------------------------------------------------------- playback

  // Plays still owed for each event. A repeated event never stacks on an alarm
  // that is still ringing; the two events keep their own count and their own
  // gap timer, so a task click during a block alarm is still heard.
  property int blockPlaysLeft: 0
  property int taskPlaysLeft: 0

  property Timer blockGap: Timer {
    id: blockGap
    repeat: false
    onTriggered: alarm.ring("block")
  }

  property Timer taskGap: Timer {
    id: taskGap
    repeat: false
    onTriggered: alarm.ring("task")
  }

  function playsLeftFor(kind) {
    return kind === "task" ? taskPlaysLeft : blockPlaysLeft
  }

  function setPlaysLeft(kind, count) {
    if (kind === "task") taskPlaysLeft = count
    else blockPlaysLeft = count
  }

  function gapTimerFor(kind) {
    return kind === "task" ? taskGap : blockGap
  }

  function soundId(kind) {
    return Model.soundForEvent(soundSettings, kind)
  }

  function tier() {
    return Model.alarmTier(inProcessReady, externalPlayer)
  }

  // The one entry point: `kind` is "block" for a work block ending or "task"
  // for a task marked complete.
  function play(kind) {
    if (!enabled) return
    if (playsLeftFor(kind) > 0) return
    setPlaysLeft(kind, Model.alarmPlays(repeat))
    ring(kind)
  }

  // One play of the alarm, then the gap that leads to the next one.
  function ring(kind) {
    var left = playsLeftFor(kind)
    if (left <= 0) return
    var id = soundId(kind)
    var which = tier()
    if (which === "in-process") {
      inProcess.item.play(kind)
    } else if (which === "external") {
      var file = Model.fileUrlToPath(assetDir + id + ".wav")
      var cmd = Model.fallbackCommand(externalPlayer, volumePercent, file)
      if (cmd.length > 0) Quickshell.execDetached(cmd)
    }
    var remaining = left - 1
    setPlaysLeft(kind, remaining)
    if (remaining > 0) {
      var timer = gapTimerFor(kind)
      timer.interval = Model.alarmRepeatIntervalMs(Model.soundDurationMs(id), Model.SOUND_GAP_MS)
      timer.restart()
    }
  }

  // Drops any alarm still repeating — used when the setting is turned off
  // mid-ring.
  function stop() {
    blockGap.stop()
    taskGap.stop()
    blockPlaysLeft = 0
    taskPlaysLeft = 0
    if (inProcess.status === Loader.Ready && inProcess.item !== null) inProcess.item.stopAll()
  }

  onEnabledChanged: if (!enabled) stop()

  Component.onCompleted: playerProbe.running = true
}
