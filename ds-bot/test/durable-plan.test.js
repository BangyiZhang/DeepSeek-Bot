import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'
import { taskStepTitle } from '../src/shared/durable-steps.js'

const code = await build({ stdin: { contents: "export { durableStepRows } from './src/client/durable-plan.js'; export { durableTaskSummary } from './src/client/durable-tasks.js'", resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react'] })
const module = { exports: {} }
runInNewContext(code.outputFiles[0].text, { module, exports: module.exports, require: () => ({}) })
const { durableStepRows, durableTaskSummary } = module.exports
const rows = job => durableStepRows(job, durableTaskSummary(job))
const base = { stepCount: 3, steps: [{ title: 'Read project' }, { title: 'Confirm changes' }, { title: 'Report outcome' }], state: { status: 'sleeping', checkpoint: { step: 1, results: ['Saved first stage'] } } }

test('saved checkpoints identify completed, current and future steps without inventing partial percentages', () => {
  assert.deepEqual(Array.from(rows(base), row => row.kind), ['completed', 'working', 'pending'])
  assert.equal(rows(base)[1].current, true)
  assert.equal(rows(base)[1].title, 'Confirm changes')
  assert.equal(durableTaskSummary(base).completed, 1)
  for (const [extra, kind] of [[{ question: { id: 'q' } }, 'waiting'], [{ paused: true }, 'paused'], [{ cancelling: true }, 'cancelling']]) {
    const plan = rows({ ...base, ...extra })
    assert.equal(plan[0].kind, 'completed')
    assert.equal(plan[1].kind, kind)
    assert.equal(plan[2].kind, 'pending')
  }
})

test('terminal outcomes retain saved steps and clearly mark the interrupted and unexecuted stages', () => {
  const failed = rows({ ...base, state: { status: 'terminal', outcome: { status: 'failed', error: { code: 'NEEDS_RECONCILIATION', completed: 1, results: ['saved'] } } } })
  assert.deepEqual(Array.from(failed, row => row.kind), ['completed', 'review', 'skipped'])
  const cancelled = rows({ ...base, state: { status: 'terminal', outcome: { status: 'aborted', result: ['saved'] } } })
  assert.deepEqual(Array.from(cancelled, row => row.kind), ['completed', 'cancelled', 'skipped'])
  const complete = rows({ ...base, state: { status: 'terminal', outcome: { status: 'completed', result: ['one', 'two', 'three'] } } })
  assert.deepEqual(Array.from(complete, row => row.kind), ['completed', 'completed', 'completed'])
  assert.equal(complete.some(row => row.current), false)
})

test('stage headings stay bounded and loading or legacy cards retain numbered fallbacks', () => {
  assert.equal(taskStepTitle('\n## Read the repository\nprivate worker context'), 'Read the repository')
  assert.equal([...taskStepTitle('🤖'.repeat(300))].length, 160)
  assert.equal(taskStepTitle(undefined), '')
  const plan = durableStepRows({ stepCount: 2, state: { status: 'preparing' } }, { count: 2, completed: 0, kind: 'preparing' }, ['1. Read files\nFull instructions', 'Summarize'])
  assert.equal(plan[0].title, 'Read files')
  assert.equal(plan[0].kind, 'pending')
  assert.equal(rows({ stepCount: 2, state: { status: 'preparing' } })[0].title, '')
})
