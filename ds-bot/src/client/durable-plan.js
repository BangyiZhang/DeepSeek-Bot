import { createElement as h, useState } from 'react'
import { CheckIcon, ChevronRightIcon } from './icons.js'
import { taskStepTitle } from '../shared/durable-steps.js'
import { t } from './i18n.js'

export function durableStepRows(job, summary, fallback = []) {
  const count = Math.max(0, Math.min(20, summary.count))
  const current = Math.max(summary.completed, Math.min(job?.state?.checkpoint?.step ?? summary.completed, count - 1))
  return Array.from({ length: count }, (_, index) => {
    const saved = job?.steps?.[index]
    const title = taskStepTitle(typeof saved === 'string' ? saved : saved?.title) || taskStepTitle(fallback[index])
    const kind = index < summary.completed ? 'completed' : index !== current ? job?.state?.status === 'terminal' ? 'skipped' : 'pending'
      : ['completed', 'preparing'].includes(summary.kind) ? 'pending'
        : summary.kind === 'pausing' ? 'working' : summary.kind
    const label = kind === 'completed' ? 'Completed' : kind === 'working' ? 'In progress' : kind === 'waiting' ? 'Waiting for your answer'
      : kind === 'paused' ? 'Paused' : kind === 'cancelling' ? 'Stopping task' : kind === 'cancelled' ? 'Cancelled'
        : kind === 'review' ? 'Needs review' : kind === 'failed' ? 'Failed' : kind === 'skipped' ? 'Not run' : 'Not started'
    return { number: index + 1, title, kind, label, current: index === current && !['pending', 'completed', 'cancelled', 'failed', 'review'].includes(kind) }
  })
}

export function DurablePlan({ job, summary, steps = [] }) {
  const [expanded, setExpanded] = useState(true)
  const rows = durableStepRows(job, summary, steps)
  if (!rows.length) return null
  return h('div', { className: 'bt-task-plan' },
    h('button', { type: 'button', className: 'bt-task-plan-toggle', 'aria-expanded': expanded, onClick: () => setExpanded(value => !value) },
      h('span', null, t('Task steps')),
      h('span', { className: 'bt-task-plan-count' }, t('{done} of {count} completed', { done: summary.completed, count: rows.length })),
      h(ChevronRightIcon)),
    expanded ? h('ol', { className: 'bt-task-steps', 'aria-label': t('Task steps') }, rows.map(row => h('li', {
      key: row.number, 'data-state': row.kind, 'aria-current': row.current ? 'step' : undefined,
      'aria-label': `${t('Step {number}', { number: row.number })}: ${row.title || t('Step {number}', { number: row.number })}, ${t(row.label)}`,
    },
    h('span', { className: 'bt-task-step-mark', 'aria-hidden': true }, row.kind === 'completed' ? h(CheckIcon) : row.number),
    h('span', { className: 'bt-task-step-copy' },
      h('span', { className: 'bt-task-step-title', title: row.title || undefined }, row.title || t('Step {number}', { number: row.number })),
      h('span', { className: 'bt-task-step-state' }, t(row.label)))))) : null)
}

export const DURABLE_PLAN_CSS = `
.bt-task-plan{margin-top:12px;border-top:1px solid var(--bt-line);padding-top:4px}
.bt-task-plan-toggle{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:4px 0;border:0;background:none;color:var(--bt-ink-2);font:inherit;font-size:12px;line-height:16px;cursor:pointer;text-align:left}
.bt-task-plan-count{margin-left:auto;font-variant-numeric:tabular-nums}
.bt-task-plan-toggle>svg{width:14px;height:14px;flex:none}
.bt-task-plan-toggle[aria-expanded=true]>svg{transform:rotate(90deg)}
.bt-task-plan-toggle:focus-visible{outline:2px solid var(--bt-accent);outline-offset:2px;border-radius:4px}
.bt-task-steps{list-style:none;display:flex;flex-direction:column;margin:4px 0 0;padding:0}
.bt-task-steps>li{position:relative;display:flex;align-items:flex-start;gap:10px;padding:8px 0;min-width:0}
.bt-task-steps>li:not(:last-child)::after{content:'';position:absolute;left:9px;top:30px;bottom:-6px;width:1px;background:var(--bt-line)}
.bt-task-step-mark{display:flex;align-items:center;justify-content:center;flex:none;box-sizing:border-box;width:20px;height:20px;border:1px solid var(--bt-line);border-radius:50%;color:var(--bt-ink-3);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}
.bt-task-step-mark>svg{width:13px;height:13px}
.bt-task-step-copy{display:flex;flex-direction:column;gap:2px;min-width:0;flex:1}
.bt-task-step-title{display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;overflow-wrap:anywhere;color:var(--bt-ink-2);font-size:13px;line-height:18px}
.bt-task-step-state{font-size:11px;line-height:16px;color:var(--bt-ink-3)}
.bt-task-steps>li[data-state=completed] .bt-task-step-mark{color:var(--bt-green);border-color:transparent;background:color-mix(in srgb,var(--bt-green) 10%,transparent)}
.bt-task-steps>li[data-state=completed] .bt-task-step-state{display:none}
.bt-task-steps>li:is([data-state=working],[data-state=waiting],[data-state=paused],[data-state=cancelling]) .bt-task-step-title{color:var(--bt-ink);font-weight:500}
.bt-task-steps>li[data-state=working] .bt-task-step-mark{color:var(--bt-accent);border-color:var(--bt-accent);background:color-mix(in srgb,var(--bt-accent) 8%,transparent)}
.bt-task-steps>li:is([data-state=waiting],[data-state=paused],[data-state=review]) .bt-task-step-mark{color:var(--bt-ink);border-style:dashed}
.bt-task-steps>li:is([data-state=failed],[data-state=cancelled]) .bt-task-step-mark{color:var(--bt-danger)}
`
