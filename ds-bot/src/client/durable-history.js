import { createElement as h, useEffect, useState } from 'react'
import { call } from './api.js'
import { ChevronRightIcon } from './icons.js'
import { dateLocale, hostText, t } from './i18n.js'

const labels = {
  created: 'Task created', step_submitted: 'Step sent to executor', step_completed: 'Step result saved',
  pause_requested: 'Pause requested', paused: 'Paused at a saved checkpoint', resume_requested: 'Continue requested',
  answer_continued: 'Continuing after your answer', cancel_requested: 'Cancellation requested',
  cancelled: 'Task cancelled', completed: 'Task completed', needs_review: 'Execution needs review',
  tool_called: 'Tool called',
}

export function durableHistoryRows(history) {
  const rows = (history?.events ?? []).filter(event => labels[event.type]).map(event => ({ ...event, label: labels[event.type] }))
  for (const question of history?.questions ?? []) rows.push({ ...question, at: question.askedAt, type: 'question', label: question.status === 'answered'
    ? 'Question answered' : question.status === 'closed' ? 'Closed without an answer' : 'Waiting for your answer' })
  return rows.sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
}

const timestamp = at => {
  if (!Number.isFinite(at) || at <= 0) return null
  const date = new Date(at)
  return h('time', { dateTime: date.toISOString(), title: date.toLocaleString(dateLocale()) }, date.toLocaleString(dateLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }))
}

export function DurableHistory({ job, summary }) {
  const [expanded, setExpanded] = useState(job?.history !== undefined)
  const [all, setAll] = useState(false)
  const [loaded, setLoaded] = useState(null)
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const history = job?.history ?? (loaded?.key === job?.key ? loaded.history : undefined)
  useEffect(() => {
    if (!expanded || !job?.key || job.history !== undefined) return
    const controller = new AbortController()
    void call('durable-state', { key: job.key }, controller.signal).then(view => {
      if (controller.signal.aborted) return
      const current = view.jobs?.find(item => item.key === job.key)
      setLoaded({ key: job.key, history: current?.history })
      setError(current ? '' : t('Task history is unavailable.'))
    }, failure => { if (!controller.signal.aborted) setError(failure?.message ?? String(failure)) })
    return () => controller.abort()
  }, [job?.key, job?.historyVersion, job?.history, expanded, retry])
  const rows = durableHistoryRows(history)
  const recent = new Set(rows.slice(-6))
  const lastQuestion = rows.findLast(row => row.type === 'question')
  const visible = all ? rows : rows.filter(row => recent.has(row) || row === lastQuestion)
  const results = summary?.results ?? []
  const failure = job?.state?.outcome?.error
  return h('section', { className: 'bt-task-history', 'aria-label': t('Task activity') },
    h('button', { className: 'bt-task-plan-toggle', type: 'button', 'aria-expanded': expanded, onClick: () => setExpanded(value => !value) },
      h('span', null, t('Task activity')), h('span', { className: 'bt-task-plan-count' }, rows.length || ''), h(ChevronRightIcon)),
    expanded ? h('div', null,
      history === undefined && !error ? h('p', { className: 'bt-task-history-note', role: 'status' }, t('Loading task history…')) : null,
      error ? h('p', { className: 'bt-task-history-note', role: 'status' }, hostText(error), ' ', h('button', { type: 'button', className: 'bt-mini', onClick: () => setRetry(value => value + 1) }, t('Refresh'))) : null,
      history && rows.length === 0 ? h('p', { className: 'bt-task-history-note' }, t('No saved activity for this task.')) : null,
      history?.omittedEvents ? h('p', { className: 'bt-task-history-note' }, t('Older activity was trimmed. Saved questions and answers are kept.')) : null,
      rows.length > visible.length || all ? h('button', { className: 'bt-mini bt-task-history-more', type: 'button', onClick: () => setAll(value => !value) }, t(all ? 'Show recent activity' : 'Show {count} earlier entries', { count: rows.length - visible.length })) : null,
      h('ol', { className: 'bt-task-history-list' }, visible.map(row => h('li', { key: row.id, 'data-type': row.type },
        h('div', { className: 'bt-task-history-meta' }, h('span', null, t(row.label)), timestamp(row.at)),
        Number.isInteger(row.step) && row.step >= 0 ? h('div', { className: 'bt-task-history-step' }, t('Step {number}', { number: row.step + 1 }), job.steps?.[row.step]?.title ? ` · ${job.steps[row.step].title}` : '') : null,
        row.tool ? h('div', { className: 'bt-task-history-step' }, row.tool) : null,
        row.type === 'question' ? h('div', { className: 'bt-task-history-question' },
          h('p', null, row.question),
          row.detail ? h('p', { className: 'bt-task-history-note' }, row.detail) : null,
          row.options?.length ? h('details', null, h('summary', null, t('Original options')), h('ul', null, row.options.map((option, index) => h('li', { key: index }, option.label, option.description ? ` — ${option.description}` : '')))) : null,
          row.answer !== undefined ? h('div', { className: 'bt-task-history-answer' }, h('div', { className: 'bt-task-history-meta' }, h('span', null, t('Your answer')), timestamp(row.answeredAt)), h('p', null, row.answer)) : null) : null))),
      results.length ? h('div', { className: 'bt-task-history-results' }, results.map((result, index) => h('details', { key: index },
        h('summary', null, t('Step {number} result', { number: index + 1 })),
        h('pre', null, typeof result === 'string' ? result : JSON.stringify(result, null, 2))))) : null,
      job?.partialResult ? h('details', null, h('summary', null, t('Step {number} partial output (not completed)', { number: job.partialResult.step + 1 })), h('pre', null, job.partialResult.text)) : null,
      failure ? h('details', { className: 'bt-task-history-failure' }, h('summary', null, t('Interruption details')),
        h('p', null, hostText(failure.message ?? '')),
        failure.execution?.endReason ? h('p', null, t('Execution ended: {reason}', { reason: failure.execution.endReason })) : null,
        failure.execution?.partial ? h('pre', null, failure.execution.partial) : null) : null) : null)
}

export const DURABLE_HISTORY_CSS = `
.bt-task-history{margin-top:12px;border-top:1px solid var(--bt-line);padding-top:4px;min-width:0}
.bt-task-history-list{list-style:none;margin:4px 0 0;padding:0}
.bt-task-history-list>li{padding:10px 0;border-bottom:1px solid var(--bt-line);overflow-wrap:anywhere}
.bt-task-history-list>li:last-child{border-bottom:0}
.bt-task-history-meta{display:flex;align-items:baseline;justify-content:space-between;gap:12px;color:var(--bt-ink-2);font-size:12px;line-height:18px}
.bt-task-history-meta time{flex:none;color:var(--bt-ink-3);font-size:11px;font-variant-numeric:tabular-nums}
.bt-task-history-step,.bt-task-history-note{color:var(--bt-ink-2);font-size:12px;line-height:19px;overflow-wrap:anywhere}
.bt-task-history-question p,.bt-task-history-failure p{margin:6px 0;white-space:pre-wrap;overflow-wrap:anywhere}
.bt-task-history-question{font-size:13px;line-height:20px;color:var(--bt-ink)}
.bt-task-history-question>p:first-child,.bt-task-history .bt-task-history-answer>p{color:var(--bt-ink)}
.bt-task-history-answer{margin-top:10px;padding-top:8px;border-top:1px solid var(--bt-line)}
.bt-task-history :is(summary,button):focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:4px}
.bt-task-history summary{cursor:pointer;color:var(--bt-ink-2);font-size:12px;line-height:20px;padding:6px 0;overflow-wrap:anywhere}
.bt-task-history ul{padding-left:20px;margin:4px 0;color:var(--bt-ink-2)}
.bt-task-history pre{font:inherit;font-size:13px;line-height:20px;white-space:pre-wrap;overflow-wrap:anywhere;margin:4px 0 10px;max-height:280px;overflow:auto;color:var(--bt-ink)}
.bt-task-history-more{margin:4px 0 8px}
.bt-task-history-results,.bt-task-history-failure{margin-top:8px}
`
