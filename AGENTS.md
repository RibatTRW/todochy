# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.
- Add a new QML file to `.no-mistakes.yaml` and `.github/workflows/ci.yml` when you add one.

## Project notes

- **The block lifecycle has one owner: `Block.js`.** It is a pure reducer —
  `Block.reduce(block, event, ctx) -> { block, effects }` — and `Engine.qml` is only the
  adapter that performs the returned effects. Do not add lifecycle rules (arming, phases,
  cadence, the catch-up window, the completion consequence chain) anywhere else.
  `CONTEXT.md` holds the vocabulary; `test/equivalence.test.mjs` holds the behaviour the
  refactor froze against the pre-refactor engine in `test/engine-reference.mjs`.
- **Task CRUD stays in `Engine.qml`** as thin calls into `Model.js`'s task helpers. Only the
  completion chain (credit the task, advance the cursor) is `Block.js`'s.
- **`state.json` is schema v1 and byte-frozen.** Its shape and its parse/serialize mapping
  live in `Block.js`; `test/block.test.mjs` pins the bytes. A schema change needs its own
  decision, not a drive-by edit.
- **The displayed derived surface must not read the clock.** `Engine.qml` derives the streak
  from `block.todayKey` / `block.lastCountedDay` / `block.currentStreak` through
  `Model.displayStreakOnDay`, and owns `tasksDone` itself, so `Panel.qml` binds to both
  instead of recounting. Reading `nowMs` there made the 250 ms ticker recompute the streak
  four times a second (measured: 36 evaluations per 8 s before, 3 after). `Block.reduce`
  rolls `block.todayKey` at midnight, so the day-rollover edge still moves the streak;
  `test/derived-view.test.mjs` pins the day-key rule to the clock-based one.
- **Checks:** `node --test test/*.test.mjs` and the `qmllint` line in `.no-mistakes.yaml`
  (mirrored in `.github/workflows/ci.yml`). Both must be green.
- **QML can only reach a second JS library through a `.import` directive**, which is invalid
  JavaScript, so `Block.js` stays `require`-able by node and takes the `Model` namespace from
  `Engine.qml` at runtime (`Block.bindModel(Model)`).
- `Model.js` holds the pure helpers `Block.js` composes plus the alarm's sound choice, volume, repeat spacing and fallback command, and is what `test/model.test.mjs` covers. `Engine.qml` is the adapter that rings `Alarm.qml` on the work-completed effect and on a task marked complete, `Panel.qml` owns the UI, and `SoundPlayer.qml` is the only file importing QtMultimedia (loaded behind a Loader, so a machine without `qt6-multimedia` cannot break the widget).
- The alarm's in-process volume maps linearly: `soundVolume / 100` is the player's volume, so the bundled files' peaks (−1.5 dBFS chime, −2.2 dBFS two-note) show up as `peak + 20·log10(v)` on the sink monitor. That is how a captured recording verifies the setting.
- **The marketplace listing is repo-root files, validated at one pinned commit.** `manifest.json`, `README.md`, `LICENSE` and `preview.png` are what `plugins.omarchy.org` reads; `omarchy plugin validate .` mirrors the manifest half of its schema. `ribattrw.todochy` is a permanent marketplace id — renaming it retires the listing — and the README's install/removal commands and its `qt6-multimedia` dependency note are listing requirements, not prose.

## Testing against the running shell

- The live Omarchy shell keeps serving the plugin QML it loaded first: editing files under `~/.config/omarchy/plugins/<id>/` (or re-running `omarchy plugin add` for the same id) leaves the running widget on the old component, and `omarchy-shell shell rescanPlugins` does not change that. To exercise edited code live, install it under a fresh plugin id (manifest `id`, `BarWidget.qml` / `Panel.qml` `moduleName`), check it, then `omarchy plugin remove` it. Do not reach for a shell restart.
- All todochy instances share one state file, `~/.local/state/omarchy/todochy/state.json`, and each engine reads it only at load. Two instances running at once therefore race for it (whichever loads last completes a seeded block), so live tests must not run in parallel across worktrees, and a sound check should be given a distinctive setting (a single play, the other bundled sound) to stay identifiable in the sink monitor.
- To check the no-`qt6-multimedia` path, mask the module in a private mount namespace instead of touching packages:
  `unshare -rm --propagation private bash -c 'mount --bind /tmp/empty /usr/lib/qt6/qml/QtMultimedia && quickshell -p <config>.qml'`.
  The Loader then reports `module "QtMultimedia" is not installed`, the widget keeps running, and the alarm falls back to an external player (or silence when the PATH has none).
- A `preview.png` capture must contain nothing of the captain's. `hyprctl output create headless` adds a wallpaper-only output whose bar renders the widget, so `grim -o HEADLESS-1` photographs the plugin with no other window in reach; remove the output afterwards, because a second monitor runs a second engine against the shared state file. On the captain's own output, pick a crop that no rectangle from `hyprctl clients -j` overlaps and photograph it once with the panel closed as the proof. Seed a demo `state.json` for the screenshot (back it up and restore it byte-exact); the live-shell file is the captain's.


## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
