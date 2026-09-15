import QtQuick
import QtMultimedia

// Todochy's in-process alarm player: one SoundEffect per event, playing the
// bundled WAVs through the shell's own Qt Multimedia backend.
//
// This is the only file in the plugin that imports QtMultimedia, and that is
// deliberate. A machine without qt6-multimedia cannot satisfy the import, and
// because this file is reached through a Loader in Alarm.qml the failure stops
// at that Loader instead of taking the widget down with it; Alarm.qml then
// falls back to an external player. The same import in Engine.qml would be
// fatal to the whole bar widget.
//
// Two effects rather than one, so a block end and a task completion can ring
// together: SoundEffect.play() while already playing is a no-op, which is what
// makes a repeated event unable to stack on the alarm it is already hearing.

QtObject {
  id: player

  // The plugin's assets/sounds/ folder, and the two files inside it.
  property string assetDir: ""
  property string blockSound: "block-chime-clean"
  property string taskSound: "task-two-note"
  property real volume: 0.55

  property SoundEffect blockEffect: SoundEffect {
    source: player.assetDir + player.blockSound + ".wav"
    volume: player.volume
  }

  property SoundEffect taskEffect: SoundEffect {
    source: player.assetDir + player.taskSound + ".wav"
    volume: player.volume
  }

  // Both files are decoded and ready to play. Until then play() is a no-op.
  readonly property bool ready: blockEffect.status === SoundEffect.Ready
    && taskEffect.status === SoundEffect.Ready

  function play(kind) {
    if (kind === "task") taskEffect.play()
    else blockEffect.play()
  }

  // Silencing an alarm already in the air, e.g. when the setting is turned off.
  function stopAll() {
    blockEffect.stop()
    taskEffect.stop()
  }
}
