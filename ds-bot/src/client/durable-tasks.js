import { createElement as h, useEffect, useId, useRef, useState } from 'react'
import { call } from './api.js'
import { PlusIcon, TrashIcon } from './icons.js'
import { hostText, t } from './i18n.js'

const MAX_STEPS = 20
const MAX_PROMPT = 24000
const resultsOf = job => job.cancellation?.results ?? (job.state?.status === 'terminal' && ['completed', 'aborted'].includes(job.state.outcome?.status)
  ? job.state.outcome.result ?? [] : job.state?.outcome?.error?.results ?? job.state?.checkpoint?.results ?? [])

export function durableTaskSummary(job) {
  const state = job.state ?? {}
  const results = resultsOf(job)
  const count = job.stepCount ?? Math.max(results.length, (state.checkpoint?.step ?? 0) + 1)
  const completed = Math.min(state.outcome?.error?.completed ?? results.length, count)
  if (job.cancelling) return { kind: 'cancelling', label: 'Stopping task', count, completed, results }
  if (state.outcome?.status === 'aborted' || job.cancellation?.status === 'stopped') return { kind: 'cancelled', label: 'Cancelled', count, completed, results }
  if (job.cancellation?.status === 'needs_reconciliation') return { kind: 'review', label: 'Needs review', count, completed, results, stopUnconfirmed: true }
  if (state.status === 'terminal') {
    const outcome = state.outcome ?? {}
    if (outcome.status === 'completed') return { kind: 'completed', label: 'Completed', count, completed: count, results }
    const review = ['NEEDS_RECONCILIATION', 'CANCEL_UNCONFIRMED'].includes(outcome.error?.code)
    return { kind: review ? 'review' : 'failed', label: review ? 'Needs review' : 'Failed', count, completed, results, error: outcome.error?.message, stopUnconfirmed: outcome.error?.code === 'CANCEL_UNCONFIRMED' }
  }
  if (job.paused) return { kind: 'paused', label: 'Paused', count, completed, results }
  if (job.pauseRequested) return { kind: 'pausing', label: 'Pausing after current step', count, completed, results }
  if (state.status === 'preparing') return { kind: 'preparing', label: 'Preparing task', count, completed: 0, results }
  if (state.status === 'missing') return { kind: 'review', label: 'Needs review', count, completed, results }
  return { kind: 'working', label: state.status === 'waiting' ? 'Waiting' : 'Working', count, completed, results }
}

const CSS = `
.bt-durable{display:flex;flex-direction:column;gap:20px;min-width:0}
.bt-durable .bt-set-section{margin:0}
.bt-durable-intro{display:flex;flex-direction:column;gap:6px}
.bt-durable-intro p{margin:0;color:var(--bt-ink-2);font-size:13px;line-height:20px}
.bt-durable-note{display:inline-flex;align-self:flex-start;align-items:center;gap:6px;font-size:11px;color:var(--bt-ink-2);padding:3px 8px;border:1px solid var(--bt-line);border-radius:999px;background:var(--bt-hover)}
.bt-durable-form{padding:16px;gap:16px}
.bt-durable-form>*+*{border-top:0}
.bt-durable-field{display:flex;flex-direction:column;gap:6px;font-size:12px;line-height:18px;color:var(--bt-ink-2)}
.bt-durable-fields{display:grid;grid-template-columns:minmax(0,1fr) minmax(160px,1fr);gap:12px}
.bt-durable-step-head{display:flex;align-items:center;justify-content:space-between;gap:8px}
.bt-durable-step-head button{width:28px;height:28px;display:inline-flex;align-items:center;justify-content:center;color:var(--bt-ink-2);background:transparent;border:0;border-radius:50%;cursor:pointer}
.bt-durable-step-head button:hover{background:var(--bt-hover)}
.bt-durable-step-head svg{width:14px;height:14px}
.bt-durable-form textarea{min-height:80px;font:inherit;font-size:13px;line-height:20px;color:var(--bt-ink)}
.bt-durable-form input,.bt-durable-form select{font-size:13px}
.bt-durable-form :is(input,textarea,select,button):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px}
.bt-durable-form fieldset{border:0;margin:0;padding:0;display:flex;flex-direction:column;gap:14px;min-width:0}
.bt-durable-submit{margin-left:auto;background:var(--bt-accent);color:var(--bt-accent-ink);border:0;border-radius:999px;min-height:36px;padding:0 18px;font:inherit;font-size:13px;font-weight:500;cursor:pointer}
.bt-durable-submit:disabled{opacity:.4;cursor:default}
.bt-durable .bt-with-icon{display:inline-flex;align-items:center;gap:5px}
.bt-durable .bt-with-icon svg{width:14px;height:14px}
.bt-durable-list{display:flex;flex-direction:column;gap:10px}
.bt-durable-job{padding:14px 16px;gap:10px}
.bt-durable-job>*+*{border-top:0}
.bt-durable-job-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px}
.bt-durable-job-name{margin:0;font-size:14px;line-height:20px;font-weight:500;overflow-wrap:anywhere}
.bt-durable-status{display:inline-flex;align-items:center;gap:6px;flex:none;font-size:11px;line-height:18px;color:var(--bt-ink-2)}
.bt-durable-status::before{content:'';width:6px;height:6px;border-radius:50%;background:var(--bt-ink-3)}
.bt-durable-status[data-kind=completed]::before{background:var(--bt-green)}
.bt-durable-status[data-kind=working]::before{background:var(--bt-accent)}
.bt-durable-status[data-kind=failed]::before{background:var(--bt-danger)}
.bt-durable-job progress{width:100%;height:4px;appearance:none;border:0;overflow:hidden;border-radius:999px;background:var(--bt-hover)}
.bt-durable-job progress::-webkit-progress-bar{background:var(--bt-hover)}
.bt-durable-job progress::-webkit-progress-value{background:var(--bt-accent);border-radius:999px}
.bt-durable-job progress::-moz-progress-bar{background:var(--bt-accent);border-radius:999px}
.bt-durable-job[data-kind=completed] progress::-webkit-progress-value{background:var(--bt-ink-3)}
.bt-durable-results{display:flex;flex-direction:column;gap:8px}
.bt-durable-result{border:1px solid var(--bt-line);border-radius:10px;overflow:hidden}
.bt-durable-result summary{padding:9px 12px;color:var(--bt-ink-2);font-size:12px;line-height:18px;cursor:pointer}
.bt-durable-result summary:focus-visible{outline:2px solid var(--bt-accent);outline-offset:-3px}
.bt-durable-result pre{margin:0;padding:0 12px 12px;font-family:inherit;white-space:pre-wrap;overflow-wrap:anywhere;font-size:13px;line-height:21px;max-height:320px;overflow:auto;color:var(--bt-ink)}
.bt-durable-session{margin-top:4px;align-self:flex-start}
.bt-durable-review{margin:0;font-size:12px;line-height:19px;color:var(--bt-ink-2)}
.bt-durable-list-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}
.bt-durable-list-head h3{margin:0}
@media(max-width:680px){.bt-durable-fields{grid-template-columns:minmax(0,1fr)}.bt-durable-job-head{flex-wrap:wrap}.bt-durable-form{padding:12px}}
`

function Job({ job, actions, refresh, readOnly }) {
  const [resuming, setResuming] = useState(false)
  const [error, setError] = useState('')
  const summary = durableTaskSummary(job)
  const resume = async () => {
    setResuming(true); setError('')
    try { await call('durable-create', { key: job.key }); refresh() }
    catch (failure) { setError(failure?.message ?? String(failure)) }
    finally { setResuming(false) }
  }
  const openSession = sessionId => { actions.closeSettings?.(); actions.openAgentSession?.(sessionId) }
  return h('article', { className: 'bt-set-card bt-durable-job', 'data-kind': summary.kind },
    h('div', { className: 'bt-durable-job-head' },
      h('h4', { className: 'bt-durable-job-name' }, job.title || t('Untitled task')),
      h('span', { className: 'bt-durable-status', 'data-kind': summary.kind }, t(summary.label))),
    h('div', { className: 'bt-set-hint' }, t('{done} of {count} steps saved', { done: summary.completed, count: summary.count })),
    summary.kind === 'pausing' ? h('p', { className: 'bt-durable-review' }, t('The current step will finish and save before pausing.')) : summary.kind === 'paused' && job.origin ? h('p', { className: 'bt-durable-review' }, t('Saved progress is kept. Say “continue” in this Bot chat to resume.')) : null,
    h('progress', { max: Math.max(summary.count, 1), value: summary.completed, 'aria-label': t('Saved progress') }),
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    summary.kind === 'preparing' ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-durable-session', disabled: resuming || readOnly, onClick: resume }, t(resuming ? 'Preparing…' : 'Resume setup')) : null,
    summary.kind === 'review' ? h('p', { className: 'bt-durable-review' }, t(summary.stopUnconfirmed ? 'Stopping could not be confirmed. This task may still be running. Check its work chat.' : 'Execution stopped at an uncertain step. Check the work chat before repeating an action.')) : null,
    ['needs_reconciliation', 'unavailable'].includes(job.notification?.status) ? h('p', { className: 'bt-durable-review' }, t('The result is saved. Check task details because its return to this chat could not be confirmed.')) : null,
    summary.kind === 'failed' && summary.error ? h('div', { className: 'bt-error', role: 'alert' }, hostText(summary.error)) : null,
    summary.results.length > 0 ? h('div', { className: 'bt-durable-results' }, summary.results.map((result, index) =>
      h('details', { key: index, className: 'bt-durable-result' },
        h('summary', null, t('Step {number} result', { number: index + 1 })),
        h('pre', null, typeof result === 'string' ? result : JSON.stringify(result, null, 2))))) : null,
    actions.openAgentSession && job.sessionIds?.length ? h('button', {
      type: 'button', className: 'bt-soft bt-soft-sm bt-durable-session',
      onClick: () => openSession(job.sessionIds[Math.min(summary.completed, job.sessionIds.length - 1)]),
    }, t('Open work chat')) : null)
}

function CreateTask({ roster, onCreated, readOnly }) {
  const available = (roster.models ?? []).filter(model => !model.needsKey)
  const defaultModel = roster.byId?.[roster.mainBotId]?.model ?? roster.defaultModel
  const [model, setModel] = useState(() => available.find(entry => entry.ref === defaultModel)?.ref ?? available[0]?.ref ?? '')
  const [title, setTitle] = useState('')
  const [prompts, setPrompts] = useState([''])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const inputId = useId()
  const admission = useRef(null)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  const chosen = available.some(entry => entry.ref === model) ? model : available.find(entry => entry.ref === defaultModel)?.ref ?? available[0]?.ref ?? ''
  const locked = Boolean(admission.current && error)
  const ready = chosen && prompts.every(prompt => prompt.trim()) && !readOnly
  const changeStep = (index, value) => setPrompts(current => current.map((prompt, at) => at === index ? value : prompt))
  const example = () => {
    setTitle(t('A relaxed weekend'))
    setPrompts([t('Suggest three activities for a relaxed weekend at home. Keep each idea to one sentence.'), t('Use the saved ideas from the previous step to write a short plan for Saturday and Sunday.')])
    setError('')
  }
  const submit = async event => {
    event.preventDefault()
    if (!ready || busy) return
    const payload = { title: title.trim() || t('Untitled task'), prompts: prompts.map(prompt => prompt.trim()), model: chosen }
    const signature = JSON.stringify(payload)
    if (admission.current && admission.current.signature !== signature) { setError(t('Clear the form before starting a different task.')); return }
    admission.current ??= { signature, key: crypto.randomUUID() }
    setBusy(true); setError('')
    try {
      await call('durable-create', { ...payload, key: admission.current.key })
      if (!alive.current) return
      admission.current = null
      setTitle(''); setPrompts([''])
      onCreated()
    } catch (failure) { if (alive.current) setError(failure?.message ?? String(failure)) }
    finally { if (alive.current) setBusy(false) }
  }
  return h('section', { className: 'bt-set-section' }, h('h3', null, t('New durable task')),
    h('form', { className: 'bt-set-card bt-durable-form', onSubmit: submit, 'aria-busy': busy || undefined },
      h('fieldset', { disabled: busy || readOnly || locked },
        h('div', { className: 'bt-durable-fields' },
          h('label', { className: 'bt-durable-field' }, t('Task name'), h('input', { className: 'bt-input', value: title, maxLength: 120, placeholder: t('What would you like to finish?'), onChange: event => setTitle(event.target.value) })),
          h('label', { className: 'bt-durable-field' }, t('Model'), h('select', { className: 'bt-select', value: chosen, onChange: event => setModel(event.target.value) },
            available.length === 0 ? h('option', { value: '' }, t('No available models')) : available.map(entry => h('option', { key: entry.ref, value: entry.ref }, `${entry.name ?? entry.id}${entry.providerName ? ` · ${entry.providerName}` : ''}`))))),
        prompts.map((prompt, index) => h('div', { key: index, className: 'bt-durable-field' },
          h('span', { className: 'bt-durable-step-head' }, h('label', { htmlFor: `${inputId}-${index}` }, t('Step {number}', { number: index + 1 })), prompts.length > 1 ? h('button', {
            type: 'button', 'aria-label': t('Remove step {number}', { number: index + 1 }), title: t('Remove step'), onClick: () => setPrompts(current => current.filter((_prompt, at) => at !== index)),
          }, h(TrashIcon)) : null),
          h('textarea', { id: `${inputId}-${index}`, className: 'bt-input bt-input-area', value: prompt, maxLength: MAX_PROMPT, rows: 3,
            placeholder: t('Describe this step. Later steps can use earlier saved results.'), onChange: event => changeStep(index, event.target.value) }))),
        h('div', { className: 'bt-actions' },
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', disabled: prompts.length >= MAX_STEPS, onClick: () => setPrompts(current => [...current, '']) }, h(PlusIcon), t('Add step')),
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: example }, t('Use an example')))),
      error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
      locked ? h('p', { className: 'bt-set-hint' }, t('Retry keeps the same task. Clear the form to start another.')) : null,
      available.length === 0 ? h('p', { className: 'bt-set-hint' }, t('Add a model in Models before starting a task.')) : null,
      h('div', { className: 'bt-actions' },
        locked ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm', disabled: busy, onClick: () => { admission.current = null; setTitle(''); setPrompts(['']); setError('') } }, t('Clear form')) : null,
        h('button', { type: 'submit', className: 'bt-durable-submit', disabled: !ready || busy }, t(busy ? 'Starting task…' : locked ? 'Retry submission' : 'Start task')))))
}

export function DurableTasksPage({ roster, actions }) {
  const [view, setView] = useState(null)
  const [error, setError] = useState('')
  const [enabling, setEnabling] = useState(false)
  const [creating, setCreating] = useState(true)
  const initialized = useRef(false)
  const [refresh, setRefresh] = useState(0)
  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])
  useEffect(() => {
    const controller = new AbortController()
    let timer
    const load = async () => {
      try {
        const next = await call('durable-state', {}, controller.signal)
        if (controller.signal.aborted) return
        if (!initialized.current) { setCreating((next.jobs?.length ?? 0) === 0); initialized.current = true }
        setView(next); setError('')
        if (next.enabled) timer = setTimeout(load, document.hidden ? 8000 : 1500)
      } catch (failure) {
        if (controller.signal.aborted) return
        setError(failure?.message ?? String(failure))
        timer = setTimeout(load, 5000)
      }
    }
    void load()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [refresh, roster.prefs?.durableTasks])
  const enable = async () => {
    setEnabling(true); setError('')
    try {
      await actions.setPrefs({ durableTasks: true })
      if (alive.current) setRefresh(value => value + 1)
    } catch (failure) { if (alive.current) setError(failure?.message ?? String(failure)) }
    finally { if (alive.current) setEnabling(false) }
  }
  const jobs = [...(view?.jobs ?? [])].reverse()
  return h('div', { className: 'bt-durable' },
    h('style', null, CSS),
    h('div', { className: 'bt-durable-intro' },
      h('span', { className: 'bt-durable-note' }, t('Experimental')),
      h('p', null, t('Tasks run in separate work chats and save each completed step. Saved steps survive an app restart.')),
      h('p', null, t('You can give a Bot a task in its own chat. Saved progress and results return there.'))),
    error ? h('div', { className: 'bt-error', role: 'alert' }, error) : null,
    view === null ? h('div', { className: 'bt-empty', role: 'status' }, t('Loading tasks…')) : !view.enabled ? h('div', { className: 'bt-set-card bt-durable-form' },
      h('p', { className: 'bt-set-hint' }, t('Enable durable tasks to try a workflow with saved progress.')),
      h('div', { className: 'bt-actions' }, h('button', { type: 'button', className: 'bt-durable-submit', disabled: enabling || view.readOnly, onClick: enable }, t(enabling ? 'Enabling…' : 'Enable durable tasks')))) : creating ? h(CreateTask, { roster, readOnly: view.readOnly, onCreated: () => { setCreating(false); setRefresh(value => value + 1) } }) : null,
    view?.enabled ? h('section', { className: 'bt-set-section' },
      h('div', { className: 'bt-durable-list-head' }, h('h3', null, t('Saved tasks · {count}', { count: jobs.length })),
        h('div', { className: 'bt-actions' },
          !creating ? h('button', { type: 'button', className: 'bt-soft bt-soft-sm bt-with-icon', disabled: view.readOnly, onClick: () => setCreating(true) }, h(PlusIcon), t('New task')) : null,
          h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => setRefresh(value => value + 1) }, t('Refresh')))),
      jobs.length > 0 ? h('div', { className: 'bt-durable-list' }, jobs.map(job => h(Job, { key: job.key, job, actions, readOnly: view.readOnly, refresh: () => setRefresh(value => value + 1) }))) : h('div', { className: 'bt-empty' }, t('No durable tasks yet. Start with a task or try the example.'))) : null)
}
