# todochy

A minimal task tracker with a Pomodoro timer for the [Omarchy](https://omarchy.org) bar.

The bar pill shows the countdown and a phase glyph — nothing else. Clicking it opens a
text-first panel with the timer, a flat task list, and a day-based streak. Every colour comes
from the active Omarchy theme, so the widget follows the user's theme with no configuration.

```
 󰔛 18:42      ← the pill: phase glyph + countdown, sitting beside omarchy.weather
```

## Features

- **Three phases** — work, short break, long break — with the classic 25 / 5 / 15 minute
  defaults and a long break every 4 work blocks. All four numbers are editable.
- **Tasks** — a flat list with one "current" task bound to the running work block. No
  projects, due dates or priorities.
- **Streak** — a day counts when at least one work block is *completed*. Missed a day and
  the streak restarts: there is no pause or freeze.
- **Persistence** — tasks, the day's completions and the streak survive shell restarts,
  written to `~/.local/state/omarchy/todochy/state.json`.
- **Notifications** — one toast per block end, replaced in place rather than stacked, with a
  click action that opens the panel.
- **Alarm sounds** — two events and no others: a work block ending, and a task being marked
  complete. Each alarm plays twice by default, at a volume you choose. Starting, pausing,
  skipping and resetting stay silent.

## Requirements

Omarchy with the Quattro shell (`omarchy-shell`). The plugin uses only the shell's own
`qs.Ui` / `qs.Commons` components, `omarchy-notification-send`, and `mkdir`.

The alarm is optional infrastructure-wise: it plays in-process through `qt6-multimedia`
when that package is installed, falls back to an external player when it is not, and stays
silent when neither exists. Nothing else about the widget depends on either.

## Install

```sh
omarchy plugin add https://github.com/RibatTRW/todochy.git --enable --yes
```

`barWidget.defaultSection` is `center`, and a centre widget with no explicit placement lands
directly after `omarchy.weather`, so the pill appears beside the weather pill with no manual
placement. To put it somewhere else:

```sh
omarchy bar move ribattrw.todochy --section center --after omarchy.weather
omarchy bar move ribattrw.todochy --section right
```

## Usage

| Where | Action | What happens |
|---|---|---|
| Pill | left click | open or close the panel |
| Pill | right click | start / pause the current block |
| Pill | middle click | skip the current block |
| Panel | click a task | make it current, or mark the current task complete |
| Panel | `add task` field | type and press Enter |
| Panel | gear button | show or hide the interval and sound settings |
| Panel | start / skip / reset | control the block |
| Panel | Escape | close the panel |

A paused timer renders dimmed; a running one is at full strength. Skipping a block never
counts toward the streak or a task's pomodoro count — only blocks that run to completion do.
Adding a task makes it current only when there is no current task or the current one is
already complete; otherwise the cursor stays where it is.

When a work block finishes:

- the completed block is credited to the current task and to today's count,
- the streak advances (or restarts, if yesterday was missed),
- the next task becomes current **only if the current one had been marked complete** during
  the block,
- the next phase begins — and waits for you to press start. Blocks never auto-start.

## Configuration

Open the panel and click the gear, or set values directly:

```sh
omarchy bar set ribattrw.todochy workMinutes 50
omarchy bar set ribattrw.todochy shortBreakMinutes 10
omarchy bar set ribattrw.todochy longBreakMinutes 20
omarchy bar set ribattrw.todochy longBreakEvery 2
omarchy bar set ribattrw.todochy soundEnabled false
omarchy bar set ribattrw.todochy soundTaskDone block-chime-clean
omarchy bar set ribattrw.todochy soundRepeat 3
omarchy bar set ribattrw.todochy soundVolume 90
```

| Key | Default | Meaning |
|---|---|---|
| `workMinutes` | `25` | length of a work block, in minutes |
| `shortBreakMinutes` | `5` | length of a short break |
| `longBreakMinutes` | `15` | length of a long break |
| `longBreakEvery` | `4` | work blocks completed before a long break |
| `soundEnabled` | `true` | play an alarm at all |
| `soundBlockEnd` | `block-chime-clean` | sound for a work block ending |
| `soundTaskDone` | `task-two-note` | sound for a task marked complete |
| `soundSameForBoth` | `false` | use the block-end sound for both events |
| `soundRepeat` | `2` | how many times each alarm plays, 1-3, with a short gap between plays |
| `soundVolume` | `55` | alarm volume, 0-100; it never touches the system volume |

Both sound keys take either of the two bundled sounds, `block-chime-clean` or
`task-two-note`, so the two events can be swapped or made identical.

Settings are stored on the widget's entry in `~/.config/omarchy/shell.json`. Every value falls
back to its default when missing, so the plugin works with an empty entry. A change takes
effect from the next start — a running block keeps its deadline, and a paused block with
partial progress keeps its remaining time, while a fresh or idle block adopts the new
length. This holds whether the change comes from the gear panel or from `omarchy bar set`.

## State

`${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/todochy/state.json` holds the task list, the
per-day completion history, and the streak counters. It is written atomically and is only ever
read by this plugin; deleting it starts from a clean slate.

The saved countdown is a wall-clock deadline, so suspending the machine or restarting the
shell does not skew a running block. A block that expired while the shell was down completes
on the next start if it expired within the last six hours; anything older is treated as
abandoned rather than credited to the streak.

## Notes

- **Sound plays on exactly two events**, a work block ending and a task being marked
  complete; a skipped or reset block makes no sound. The alarm plays in-process through Qt
  Multimedia, so it needs `qt6-multimedia` — not an Omarchy dependency, and the reason the
  plugin has a second path. Without it, todochy falls back to the first external player it
  finds (`mpv`, `pw-play`, `paplay`, `ffplay`, `canberra-gtk-play`, `aplay`); with none of
  those the alarm stays silent instead of failing, and the gear panel says so. On that
  fallback path the volume setting scales `mpv`, `pw-play` and `paplay` only —
  `ffplay`, `canberra-gtk-play` and `aplay` take no volume flag and play at their own
  level — except that volume 0 mutes the alarm on every player. The two bundled
  sounds in `assets/sounds/` are original synthesised works, synthesised from
  scratch for this plugin, and ship under its MIT licence.
- **No sync, accounts, projects, due dates or priorities.** That is the point.
- The plugin is a single `bar-widget`; the panel is `Panel.qml` loaded by `BarWidget.qml`, not
  a second plugin kind.

## Development

```sh
omarchy plugin clone omarchy.clock --edit     # or work in a checkout of this repo
omarchy plugin validate .
node --test test/*.test.mjs                   # the lifecycle and the rules
```

`Block.js` owns the block lifecycle — arming a phase length, the three phases, a settings
change arriving mid-block, the six-hour catch-up window, and the whole consequence chain of a
finished work block — as one pure reducer that returns the next block plus the effects the
caller must perform. `Model.js` holds the pure helpers it composes (settings clamping, phase
lengths, formatting, calendar days, streak arithmetic, task rules) plus the alarm's sound
choice, volume, repeat spacing and fallback command. `test/block.test.mjs` drives the
lifecycle with an injected clock, `test/model.test.mjs` the helpers, and
`test/equivalence.test.mjs` pins the whole seam against a frozen copy of the engine as it
behaved before that refactor.

`Engine.qml` is the adapter: the ticker, the file IO, the notification process and the
read-only projection of the block value onto the properties the panel binds to — including
ringing `Alarm.qml` on the work-completed effect and on a task marked complete.
`Panel.qml` owns the UI, `Alarm.qml` owns the two audible events, and `SoundPlayer.qml` is
the in-process player it loads — the only file that imports QtMultimedia, so a machine
without that package cannot break the widget. `CONTEXT.md` has the vocabulary, and
[docs/development.md](docs/development.md) has the design invariants, the checks to run, and
how to test a change against the running shell.

To lint against the installed shell, an import root shaped like the `qs.*` module names is
needed, because the shell's module directories are `shell/Commons` and `shell/Ui` while the
imports are `qs.Commons` and `qs.Ui`:

```sh
mkdir -p .lint-import/qs
ln -sfn "$OMARCHY_PATH/shell/Commons" .lint-import/qs/Commons
ln -sfn "$OMARCHY_PATH/shell/Ui"      .lint-import/qs/Ui
qmllint -I "$OMARCHY_PATH/shell" -I "$PWD/.lint-import" BarWidget.qml Engine.qml Panel.qml Alarm.qml SoundPlayer.qml
```

Do not commit `.lint-import` — the plugin validator rejects symlinks inside a plugin folder.

## Remove

```sh
omarchy plugin remove ribattrw.todochy
rm -rf "${XDG_STATE_HOME:-$HOME/.local/state}/omarchy/todochy"
```

## License

MIT — see [LICENSE](LICENSE).
