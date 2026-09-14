import QtQuick
import qs.Ui

// Todochy's bar entry point: a 26px pill showing the countdown and the phase
// glyph, plus the nested panel that holds everything else.
//
// The pill is deliberately sparse — time plus phase glyph, nothing more — and
// carries the widget's lifecycle contract so `omarchy-shell shell
// summon|hide|toggle ribattrw.todochy` and the panel hotkeys reach the loaded
// panel. The panel is loaded from this file rather than declared as a second
// plugin kind, which is how a bar widget with a details popup is built.
//
// Interactions follow the bar's existing convention: left click opens the
// panel, right click starts or pauses, middle click skips the current block.

BarWidget {
  id: root
  moduleName: "ribattrw.todochy"

  // One engine per widget instance; the bar surface exists per monitor and the
  // countdown must outlive the panel being closed.
  property Engine engine: Engine {
    host: root
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false
  readonly property bool popoutSwitchClosing: panelLoader.item
    ? panelLoader.item.popoutSwitchClosing === true
    : false

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  function open() {
    if (panelLoader.item && panelLoader.item.open) panelLoader.item.open()
  }

  function close() {
    if (panelLoader.item && panelLoader.item.close) panelLoader.item.close()
  }

  function toggle() {
    if (panelLoader.item && panelLoader.item.toggle) panelLoader.item.toggle()
  }

  function closeForPopoutSwitch() {
    if (panelLoader.item && panelLoader.item.closeForPopoutSwitch)
      panelLoader.item.closeForPopoutSwitch()
  }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    visible: false
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  WidgetButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    text: root.engine.phaseGlyph + " " + root.engine.displayTime
    // A paused timer reads as greyed out without adding another mark to the bar.
    dimmed: !root.engine.running
    // The panel is the detail view; a tooltip would compete with it.
    tooltipText: ""

    onPressed: function(code) {
      if (code === Qt.RightButton) root.engine.toggleRunning()
      else if (code === Qt.MiddleButton) root.engine.skip()
      else root.toggle()
    }
  }
}
