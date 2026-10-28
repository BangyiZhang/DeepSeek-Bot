import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { build } from 'esbuild'

const requireHarness = createRequire(join(process.env.DSH_HARNESS, 'package.json'))
const React = requireHarness('react')
const { JSDOM } = requireHarness('jsdom')
const { outputFiles } = await build({ stdin: { contents: `
  export { TasksPage, taskPageRoute } from './src/client/tasks-page.js'
  export { DurableChatTask } from './src/client/durable-chat.js'
  export { durableTaskView } from './src/client/durable-task-view.js'
`, resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, bundle: true, format: 'cjs', platform: 'browser', write: false,
external: ['react', 'react-dom', '@deepseek-ai/dsh-client-ui-primitives'] })

test('existing scheduled tasks and Pi tasks share UI without sharing task identities or operations', async () => {
  const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true })
  const { window } = dom
  window.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} })
  const previous = {}
  for (const key of ['window', 'document', 'IS_REACT_ACT_ENVIRONMENT']) previous[key] = globalThis[key]
  Object.assign(globalThis, { window, document: window.document, IS_REACT_ACT_ENVIRONMENT: true })
  const { createRoot } = requireHarness('react-dom/client')
  const scheduled = { id: 'same-key', sessionId: 'owner', botId: 'owner', title: 'Daily briefing', prompt: 'Read updates', kind: 'daily', time: '09:00', timeZone: 'UTC', status: 'active', scheduledAt: '2026-10-29T09:00:00Z' }
  const saved = { key: 'same-key', title: 'Inspect repository', ownerName: 'Chief', botManaged: true, origin: { botId: 'owner' },
    stepCount: 2, sessionIds: ['worker'], steps: [{ title: 'Read files' }, { title: 'Report result' }],
    paused: true, state: { status: 'waiting', checkpoint: { step: 1, results: ['Read result'] } },
    history: { events: [], questions: [{ id: 'q1', status: 'answered', question: 'Continue with changes?', answer: 'Yes, continue', askedAt: 10, answeredAt: 20, step: 0 }] } }
  const requests = []
  const deletions = []
  const navigation = []
  let tasks = [scheduled]
  let scheduleAvailable = true
  let durableEnabled = true
  const module = { exports: {} }
  runInNewContext(outputFiles[0].text, { module, exports: module.exports, window, document: window.document,
    setTimeout, clearTimeout, AbortController, console, ResizeObserver: undefined,
    requestAnimationFrame: window.requestAnimationFrame.bind(window), cancelAnimationFrame: window.cancelAnimationFrame.bind(window),
    fetch: async (_url, options) => {
      const request = JSON.parse(options.body)
      requests.push(request)
      assert.equal(request.endpoint, 'durable-state', 'viewing Pi tasks must not create, resume, or schedule work')
      return { ok: true, json: async () => ({ ok: true, value: { enabled: durableEnabled, jobs: durableEnabled ? [saved] : [] } }) }
    },
    require: name => name === '@deepseek-ai/dsh-client-ui-primitives' ? { MarkdownText: () => null } : requireHarness(name),
  })
  const { TasksPage, DurableChatTask, taskPageRoute, durableTaskView } = module.exports
  const roster = { mainBotId: 'owner', bots: [{ id: 'owner', name: 'Chief', color: 'blue' }], rooms: [], byId: { owner: { id: 'owner', name: 'Chief' } }, prefs: {}, models: [] }
  const actions = {
    schedules: async () => ({ available: scheduleAvailable, tasks }),
    scheduleDelete: async (sessionId, id) => { deletions.push([sessionId, id]); tasks = []; return { available: true, tasks } },
    openSettings: (...args) => navigation.push(args),
  }
  const root = createRoot(window.document.getElementById('root'))
  const render = async element => React.act(async () => { root.render(element); await new Promise(resolve => setTimeout(resolve, 10)) })
  const click = async element => React.act(async () => { assert.ok(element); element.click(); await new Promise(resolve => setTimeout(resolve, 10)) })
  const byText = text => [...window.document.querySelectorAll('button')].find(node => node.textContent === text)
  try {
    assert.equal(taskPageRoute('schedules', 'owner').start, 'owner')
    assert.equal(taskPageRoute('durable').section, 'saved')
    assert.equal(taskPageRoute('tasks', 'saved').section, 'saved')
    // Legacy schedule links still open the original Bot-specific create form.
    await render(React.createElement(TasksPage, { page: 'schedules', id: 'owner', roster, actions }))
    assert.equal(window.document.querySelector('select').value, 'owner')
    await click(byText('Cancel'))
    assert.ok(window.document.querySelector('[data-task-source="schedule"]'))
    assert.equal(window.document.querySelector('[data-task-source="schedule"]').dataset.taskId, 'schedule:owner:same-key')
    assert.equal(requests.length, 0)
    await click(byText('Saved progress'))
    assert.deepEqual(navigation.pop(), ['tasks', 'saved'])
    await render(React.createElement(TasksPage, { page: 'tasks', id: 'saved', roster, actions }))
    assert.ok(window.document.querySelector('.bt-task-card [data-task-source="durable"]'))
    assert.match(window.document.body.textContent, /Paused/)
    assert.equal(window.document.querySelector('progress').value, 1)
    assert.equal(window.document.querySelector('progress').max, 2)
    assert.match(window.document.body.textContent, /Continue with changes\?/)
    assert.match(window.document.body.textContent, /Yes, continue/)
    assert.equal(window.document.querySelector('.bt-task-remove'), null)
    assert.equal(deletions.length, 0)
    // The conversation uses the same card, progress and status adapter.
    await render(React.createElement(DurableChatTask, { admission: { key: saved.key }, actions }))
    assert.ok(window.document.querySelector('.bt-durable-chat.bt-task-card'))
    assert.equal(window.document.querySelector('[data-task-source="durable"]').dataset.taskId, 'durable:same-key')
    await click(byText('View task'))
    assert.deepEqual(navigation.pop(), ['durable'])
    for (const [extra, kind] of [[{ cancelling: true }, 'cancelling'], [{ question: { id: 'new' }, paused: false }, 'waiting'], [{ paused: false, state: { status: 'missing' } }, 'review']]) {
      assert.equal(durableTaskView({ ...saved, ...extra }).status.kind, kind)
    }
    // A disabled Schedule service leaves Pi visible and readable.
    scheduleAvailable = false
    await render(React.createElement(TasksPage, { page: 'tasks', roster, actions }))
    assert.match(window.document.body.textContent, /Turn on Automation tasks in DSH/)
    await render(React.createElement(TasksPage, { page: 'durable', roster, actions }))
    assert.ok(window.document.querySelector('[data-task-source="durable"]'))
    // A disabled Pi service does not change the Schedule catalog or its controls.
    durableEnabled = false
    await render(React.createElement(TasksPage, { page: 'tasks', roster, actions }))
    await render(React.createElement(TasksPage, { page: 'durable', roster, actions }))
    assert.match(window.document.body.textContent, /Enable durable tasks/)
    scheduleAvailable = true
    await render(React.createElement(TasksPage, { page: 'tasks', roster, actions }))
    // The existing two-click deletion still targets only the original Schedule.
    await click(window.document.querySelector('.bt-task-remove'))
    assert.equal(deletions.length, 0)
    await click(window.document.querySelector('.bt-task-remove'))
    assert.deepEqual(deletions, [['owner', 'same-key']])
    assert.match(window.document.body.textContent, /No scheduled tasks yet/)
    assert.ok(requests.every(request => request.endpoint === 'durable-state'))
  } finally {
    await React.act(async () => root.unmount())
    dom.window.close()
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete globalThis[key]
      else globalThis[key] = value
    }
  }
})
