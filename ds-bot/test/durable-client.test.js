import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const bundle = await build({
  entryPoints: [fileURLToPath(new URL('../src/client/durable-tasks.js', import.meta.url))],
  bundle: true, format: 'cjs', platform: 'node', write: false, external: ['react'],
})
const module = { exports: {} }
runInNewContext(bundle.outputFiles[0].text, {
  module, exports: module.exports,
  require: name => { if (name === 'react') return {}; throw new Error(`Unexpected dependency ${name}`) },
})
const { durableTaskSummary } = module.exports

test('cancellation is only final after confirmation and retains completed stages', () => {
  const stopping = durableTaskSummary({ cancelling: true, stepCount: 2, state: { checkpoint: { results: ['saved'] } } })
  assert.equal(stopping.label, 'Stopping task')
  const stopped = durableTaskSummary({ stepCount: 2, state: { status: 'terminal', outcome: { status: 'aborted', result: ['saved'] } } })
  assert.equal(stopped.label, 'Cancelled')
  assert.equal(stopped.completed, 1)
  assert.equal(durableTaskSummary({ state: { status: 'terminal', outcome: { status: 'failed', error: { code: 'CANCEL_UNCONFIRMED' } } } }).label, 'Needs review')
})

test('failed later steps retain earlier saved results in the task summary', () => {
  const saved = ['First step result']
  const summary = durableTaskSummary({ stepCount: 3, state: { status: 'terminal', outcome: {
    status: 'failed', error: { code: 'NEEDS_RECONCILIATION', results: saved, completed: 1 },
  } } })
  assert.equal(summary.kind, 'review')
  assert.equal(summary.completed, 1)
  assert.equal(summary.count, 3)
  assert.equal(summary.results, saved)
})

test('preparing and missing task records are not presented as running execution', () => {
  const preparing = durableTaskSummary({ stepCount: 2, state: { status: 'preparing' } })
  assert.equal(preparing.kind, 'preparing')
  assert.equal(preparing.completed, 0)
  assert.equal(durableTaskSummary({ state: { status: 'missing' } }).kind, 'review')
})

test('completed tasks expose all saved step results and a complete progress count', () => {
  const saved = ['One', 'Two']
  const summary = durableTaskSummary({ stepCount: 2, state: { status: 'terminal', outcome: { status: 'completed', result: saved } } })
  assert.equal(summary.kind, 'completed')
  assert.equal(summary.completed, 2)
  assert.equal(summary.results, saved)
})
