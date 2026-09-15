# todochy — context

The vocabulary this plugin is built from. It is here so a change can pick the
word the code already uses instead of inventing a second one.

| Word | Meaning | Owner |
|---|---|---|
| **block** | One run of one phase, from arm to end. The unit a user starts, pauses, skips or completes. | `Block.js` |
| **phase** | `work`, `short` or `long`. Which one is current decides what a completion credits. | `Block.js` / `Model.js` |
| **arm** | Give the current countdown its full phase length. Every phase transition arms the next block and then waits. | `Block.js` |
| **armedMs** | The phase length the current countdown was armed from. Transient: never persisted, re-derived on load. The one field a settings-change rule needs. | `Block.js` |
| **cadence** | Which phase follows a completed work block, and how far into the long-break cycle it is. | `Block.js` |
| **cycle** | `longBreakEvery` work blocks, after which the break is a long one. `cycleBlocks` counts completed work blocks since the last long break. | `Block.js` |
| **credit** | A completed work block's pomodoro on the current task. Only a natural completion credits; a skip never does. | `Block.js` |
| **completion** | A block that reached its deadline, as opposed to a **skip**. Only a completion credits and notifies. | `Block.js` |
| **effects** | The work outside the module, returned as data: `persist`, `notify`, `credit`. The caller performs them. | `Block.js` → `Engine.qml` |
| **catch-up** | A block that expired while the shell was down completes on load if it expired within six hours; anything older is abandoned and never credited. | `Block.js` |
| **streak** | Consecutive local days each with at least one completed work block. A missed day is a hard reset to 1. | `Block.js` / `Model.js` |
| **settings change** | The settings value changing, from the panel's fields or from `omarchy bar set`. One rule for both: a fresh block adopts the new length, a paused one keeps its remaining time, a running one keeps its deadline — and the length it was armed from, so a shorter value written mid-run can never shrink a later pause. | `Block.js` |
| **seam** | `Block.reduce(block, event, ctx)`. The one place the lifecycle can be entered and the one place it can be wrong. | `Block.js` |
| **adapter** | The shell-side work the lifecycle cannot do: the ticker, `state.json`, the notification process, the widget's settings entry. | `Engine.qml` |
| **projection** | The read-only view of the block value that `Panel.qml` and `BarWidget.qml` bind to (`engine.tasks`, `engine.running`, …). | `Engine.qml` |

Two vocabularies live outside this file on purpose: `Panel.qml` speaks the
shell's UI words (`Panel`, `PanelActionButton`, `Style`), and `manifest.json`
speaks the plugin contract's (`barWidget`, `defaults`, `schema`).

## Where a change goes

- A rule about what a block *does* → `Block.js`, with a test in
  `test/block.test.mjs`.
- A pure helper that is not the lifecycle → `Model.js`, with a test in
  `test/model.test.mjs`.
- The shell, a process, a file or a timer → `Engine.qml`.
- Anything painted on screen → `Panel.qml` / `BarWidget.qml`.

`test/equivalence.test.mjs` compares `Block.js` against a frozen copy of the
engine as it behaved before the refactor (`test/engine-reference.mjs`). If those
two disagree, a user-visible behaviour has changed.
