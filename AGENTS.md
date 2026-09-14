# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

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
- **Checks:** `node --test test/*.test.mjs` and the `qmllint` line in `.no-mistakes.yaml`
  (mirrored in `.github/workflows/ci.yml`). Both must be green.
- **QML can only reach a second JS library through a `.import` directive**, which is invalid
  JavaScript, so `Block.js` stays `require`-able by node and takes the `Model` namespace from
  `Engine.qml` at runtime (`Block.bindModel(Model)`).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
