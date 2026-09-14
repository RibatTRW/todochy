// The engine's task CRUD layer, as the tests need to drive it.
//
// Task CRUD deliberately stays outside the Block reducer: the reducer owns the
// *lifecycle*, and adding, selecting, completing and deleting rows are thin
// calls into Model's pure task helpers over the block value. This is a
// transcription of those four functions from Engine.qml so the tests can drive
// a task gesture the way the panel does.

import { createRequire } from "node:module"

const require = createRequire(import.meta.url)
const Model = require("../Model.js")

function persist(block, patch) {
  return {
    block: Object.assign({}, block, patch),
    effects: [{ kind: "persist" }]
  }
}

export const engineOps = {
  addTask(block, text) {
    const value = String(text || "").trim()
    if (value === "") return { block, effects: [] }
    const task = Model.normalizeTask({ text: value })
    if (!task) return { block, effects: [] }
    return persist(block, {
      tasks: block.tasks.concat([task]),
      currentTaskId: Model.currentTaskIdAfterAdd(block.tasks, block.currentTaskId, task.id)
    })
  },

  selectTask(block, id) {
    if (id === block.currentTaskId) return { block, effects: [] }
    if (!Model.hasTask(block.tasks, id)) return { block, effects: [] }
    return persist(block, { currentTaskId: id })
  },

  setTaskDone(block, id, done) {
    const tasks = block.tasks.map((t) => (t.id === id
      ? { id: t.id, text: t.text, done: done === true, pomos: t.pomos }
      : t))
    return persist(block, { tasks })
  },

  deleteTask(block, id) {
    const tasks = block.tasks.filter((t) => t.id !== id)
    const patch = { tasks }
    if (block.currentTaskId === id) patch.currentTaskId = Model.nextIncompleteTaskId(tasks, "")
    return persist(block, patch)
  },

  // One click, three meanings: select an open task, complete the current one,
  // or reopen a completed one.
  handleTaskClick(block, id) {
    const task = block.tasks.find((t) => t.id === id)
    if (!task) return { block, effects: [] }
    if (task.done) return engineOps.setTaskDone(block, id, false)
    if (id === block.currentTaskId) return engineOps.setTaskDone(block, id, true)
    return engineOps.selectTask(block, id)
  }
}

// An id known to be unused by `block`, so a test can name a row.
export function seedTasks(block, rows, currentTaskId) {
  const tasks = rows.map((row) => ({
    id: row.id,
    text: row.text,
    done: row.done === true,
    pomos: row.pomos || 0
  }))
  return Object.assign({}, block, { tasks, currentTaskId: currentTaskId || "" })
}
