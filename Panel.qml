import QtQuick
import qs.Commons
import qs.Ui
import "Model.js" as Model

// Todochy's panel: the "Ledger" direction the captain chose — text-first, no
// container shapes of its own, the theme accent spent as data ink (the progress
// rule, the current-task caret, the phase label) rather than decoration.
//
// Loaded by BarWidget.qml, not declared as a second plugin kind. It owns no
// state: everything comes from the engine on the bar widget, so closing the
// panel never disturbs the countdown.
//
// The interval settings are hidden behind the gear button by the captain's
// request: the panel body shows only the timer, the cadence, the tasks and the
// streak.

Panel {
  id: root
  moduleName: "ribattrw.todochy"
  manageIpc: false

  property var anchorItem: null
  property var hostWidget: null
  readonly property var engine: hostWidget ? hostWidget.engine : null

  // Panel-local UI state; deliberately not persisted, so a reopened panel is
  // always the uncluttered view.
  property bool settingsOpen: false

  readonly property color textColor: root.barForeground
  // The hero is the one piece of type allowed to be large; it scales with the
  // user's font setting instead of being pinned to pixels.
  readonly property int heroSize: Math.round(Style.font.displayLarge * 2)

  readonly property int tasksTotal: engine ? engine.tasks.length : 0
  readonly property int tasksDone: {
    var list = engine ? engine.tasks : []
    var done = 0
    for (var i = 0; i < list.length; i++) if (list[i].done) done++
    return done
  }

  function dots(count) {
    var text = ""
    for (var i = 0; i < count; i++) text += "●"
    return text
  }

  function switchPanel(direction) {
    if (root.bar && typeof root.bar.switchPanelFrom === "function")
      return root.bar.switchPanelFrom(root.hostWidget || root, direction)
    return false
  }

  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root.hostWidget || root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(340))
    contentHeight: panel.fittedContentHeight(content.implicitHeight, Style.space(620))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      // Let the add-task field take keys while it is focused.
      blocked: taskInput.activeFocus
      onCloseRequested: root.close()
      onTabRequested: function(direction) { root.switchPanel(direction) }
      // PanelKeyCatcher emits returnRequested *and* activateRequested for one
      // Return, so only the activate handler may drive the timer: wiring both
      // started the block and paused it again in the same keystroke. Space
      // emits activateRequested alone, so both keys now toggle exactly once.
      onActivateRequested: if (root.engine) root.engine.toggleRunning()

      Column {
        id: content
        width: parent.width
        spacing: Style.spacing.lg

        // ------------------------------------------------ phase + gear
        Item {
          width: parent.width
          height: Math.max(phaseLabel.implicitHeight, gearButton.size)

          Text {
            id: phaseLabel
            anchors.left: parent.left
            anchors.verticalCenter: parent.verticalCenter
            text: root.engine
              ? root.engine.phaseLabel.toUpperCase() + " · BLOCK " + root.engine.cyclePos
                + " OF " + root.engine.longBreakEvery
              : ""
            color: Color.accent
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: true
            textFormat: Text.PlainText
          }

          PanelActionButton {
            id: gearButton
            anchors.right: parent.right
            anchors.verticalCenter: parent.verticalCenter
            iconText: Model.GLYPHS.gear
            tooltipText: root.settingsOpen ? "Hide settings" : "Edit settings"
            foreground: root.settingsOpen ? Color.accent : root.textColor
            onClicked: root.settingsOpen = !root.settingsOpen
          }
        }

        // -------------------------------------------------- hero time
        Text {
          width: parent.width
          text: root.engine ? root.engine.displayTime : "--:--"
          color: (root.engine && root.engine.runningOut) ? Color.urgent : root.textColor
          font.family: Style.font.family
          font.pixelSize: root.heroSize
          textFormat: Text.PlainText
        }

        // The block's progress: the one place accent encodes data in this
        // direction.
        Rectangle {
          width: parent.width
          height: Math.max(1, Style.space(2))
          color: Style.normalBorderColor

          Rectangle {
            width: parent.width * (root.engine ? root.engine.progress : 0)
            height: parent.height
            color: Color.accent
          }
        }

        // ---------------------------------------------------- task list
        Item {
          width: parent.width
          height: tasksLabel.implicitHeight

          Text {
            id: tasksLabel
            anchors.left: parent.left
            text: "TASKS"
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            font.bold: true
            textFormat: Text.PlainText
          }

          Text {
            anchors.right: parent.right
            text: root.tasksDone + "/" + root.tasksTotal + " done"
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            textFormat: Text.PlainText
          }
        }

        Flickable {
          id: taskFlick
          width: parent.width
          height: Math.min(taskColumn.implicitHeight, Style.space(9 * 22))
          contentHeight: taskColumn.implicitHeight
          clip: true
          boundsBehavior: Flickable.StopAtBounds
          interactive: contentHeight > height

          Column {
            id: taskColumn
            width: taskFlick.width
            spacing: Style.spacing.xxs

            Repeater {
              model: root.engine ? root.engine.tasks : []

              delegate: Item {
                id: rowItem
                required property var modelData
                width: taskColumn.width
                height: Math.max(rowLabel.implicitHeight, Style.space(22))

                readonly property bool isCurrent: root.engine
                  ? root.engine.currentTaskId === rowItem.modelData.id
                  : false

                Text {
                  id: rowBox
                  anchors.left: parent.left
                  anchors.verticalCenter: parent.verticalCenter
                  text: rowItem.modelData.done ? "[x]" : "[ ]"
                  color: rowItem.modelData.done ? Color.muted : root.textColor
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                  textFormat: Text.PlainText
                }

                Text {
                  id: rowCaret
                  anchors.left: rowBox.right
                  anchors.leftMargin: Style.spacing.xs
                  anchors.verticalCenter: parent.verticalCenter
                  text: rowItem.isCurrent ? "▸" : " "
                  color: Color.accent
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                  textFormat: Text.PlainText
                }

                Text {
                  id: rowLabel
                  anchors.left: rowCaret.right
                  anchors.leftMargin: Style.spacing.xs
                  anchors.right: rowPomos.left
                  anchors.rightMargin: Style.spacing.xs
                  anchors.verticalCenter: parent.verticalCenter
                  text: rowItem.modelData.text
                  color: rowItem.modelData.done ? Color.muted : root.textColor
                  font.family: Style.font.family
                  font.pixelSize: Style.font.body
                  font.strikeout: rowItem.modelData.done
                  elide: Text.ElideRight
                  textFormat: Text.PlainText
                }

                Text {
                  id: rowPomos
                  anchors.right: parent.right
                  anchors.verticalCenter: parent.verticalCenter
                  text: root.dots(rowItem.modelData.pomos)
                  color: Color.muted
                  font.family: Style.font.family
                  font.pixelSize: Style.font.caption
                  textFormat: Text.PlainText
                }

                MouseArea {
                  anchors.fill: parent
                  cursorShape: Qt.PointingHandCursor
                  onClicked: if (root.engine) root.engine.handleTaskClick(rowItem.modelData.id)
                }
              }
            }
          }
        }

        TextField {
          id: taskInput
          width: parent.width
          placeholderText: "add task"
          onAccepted: {
            if (root.engine) root.engine.addTask(text)
            text = ""
          }
        }

        // --------------------------------------------------- streak
        PanelSeparator {
          width: parent.width
        }

        Item {
          width: parent.width
          height: Math.max(streakLabel.implicitHeight, todayLabel.implicitHeight)

          Text {
            id: streakLabel
            anchors.left: parent.left
            text: Model.GLYPHS.streak + " " + (root.engine ? root.engine.streak : 0) + " day streak"
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            textFormat: Text.PlainText
          }

          Text {
            id: todayLabel
            anchors.right: parent.right
            text: (root.engine ? root.engine.todayBlocks : 0) + " today"
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.bodySmall
            textFormat: Text.PlainText
          }
        }

        // Fourteen days of history. A day is filled when at least one work
        // block was completed; the newest square is today.
        Row {
          spacing: Style.spacing.xxs

          Repeater {
            model: root.engine ? root.engine.recentDaysList(14) : []

            delegate: Rectangle {
              required property var modelData
              width: Style.space(10)
              height: Style.space(10)
              color: modelData.hit ? Color.accent : Style.normalFill
              border.width: modelData.today ? 1 : 0
              border.color: root.textColor
            }
          }
        }

        // --------------------------------------------------- actions
        Row {
          spacing: Style.spacing.lg

          Button {
            text: (root.engine && root.engine.running) ? "pause" : "start"
            foreground: root.textColor
            onClicked: if (root.engine) root.engine.toggleRunning()
          }

          Button {
            text: "skip"
            foreground: root.textColor
            onClicked: if (root.engine) root.engine.skip()
          }

          Button {
            text: "reset"
            foreground: root.textColor
            onClicked: if (root.engine) root.engine.resetBlock()
          }
        }

        // ---------------------------------------- settings (gear only)
        Column {
          width: parent.width
          spacing: Style.spacing.sm
          visible: root.settingsOpen

          PanelSeparator {
            width: parent.width
          }

          PanelSectionHeader {
            text: "INTERVALS"
            foreground: root.textColor
          }

          Row {
            spacing: Style.spacing.md

            NumberField {
              label: "work"
              value: root.engine ? root.engine.workMinutes : 25
              from: 1
              to: 600
              stepSize: 5
              fieldWidth: Style.space(100)
              foreground: root.textColor
              onModified: function(value) { if (root.engine) root.engine.setSetting("workMinutes", value) }
            }

            NumberField {
              label: "short"
              value: root.engine ? root.engine.shortBreakMinutes : 5
              from: 1
              to: 600
              stepSize: 1
              fieldWidth: Style.space(100)
              foreground: root.textColor
              onModified: function(value) { if (root.engine) root.engine.setSetting("shortBreakMinutes", value) }
            }
          }

          Row {
            spacing: Style.spacing.md

            NumberField {
              label: "long"
              value: root.engine ? root.engine.longBreakMinutes : 15
              from: 1
              to: 600
              stepSize: 5
              fieldWidth: Style.space(100)
              foreground: root.textColor
              onModified: function(value) { if (root.engine) root.engine.setSetting("longBreakMinutes", value) }
            }

            NumberField {
              label: "every"
              value: root.engine ? root.engine.longBreakEvery : 4
              from: 1
              to: 24
              stepSize: 1
              fieldWidth: Style.space(100)
              foreground: root.textColor
              onModified: function(value) { if (root.engine) root.engine.setSetting("longBreakEvery", value) }
            }
          }

          Text {
            width: parent.width
            text: "Minutes for a work block, a short break and a long break; then how many work blocks come before a long one."
            color: Color.muted
            font.family: Style.font.family
            font.pixelSize: Style.font.caption
            wrapMode: Text.WordWrap
            textFormat: Text.PlainText
          }
        }
      }
    }
  }
}
