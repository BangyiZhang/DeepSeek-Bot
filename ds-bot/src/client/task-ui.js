import { createElement as h } from 'react'
import { t } from './i18n.js'

// Views receive presentation data and callbacks; they never choose a task engine.
export function TaskRow({ task, actions, children, className = '' }) {
  return h('div', { className: `bt-set-row bt-task ${className}`.trim(), 'data-task-id': task.id, 'data-task-source': task.source,
    'data-done': task.done || undefined, 'data-busy': task.busy || undefined },
  task.avatar,
  h('span', { className: 'bt-set-copy' },
    h('strong', { className: 'bt-task-title' }, task.title),
    task.subtitle ? h('span', { className: 'bt-set-hint' }, task.subtitle) : null,
    task.prompt ? h('span', { className: 'bt-task-prompt' }, task.prompt) : null),
  task.status ? h('span', { className: 'bt-task-status', 'data-kind': task.status.kind, role: 'status' }, task.status.label) : null,
  task.meta ? h('span', { className: 'bt-task-next' }, task.meta) : null,
  actions,
  children)
}

export function TaskCard({ task, actions, children, className = '', label }) {
  return h('article', { className: `bt-set-card bt-task-card ${className}`.trim(), 'data-kind': task.status?.kind, 'aria-label': label },
    h(TaskRow, { task, actions }),
    h('div', { className: 'bt-task-detail' }, children))
}

export function TaskProgress({ completed, count }) {
  return h('progress', { className: 'bt-task-progress', max: Math.max(count, 1), value: completed, 'aria-label': t('Saved progress') })
}

export const TASK_UI_CSS = `
.bt-task{gap:10px;min-width:0;flex-wrap:wrap}
.bt-task>.bt-set-copy{flex:1;min-width:100px}
.bt-task[data-done]{opacity:.6}
.bt-task[data-busy]{opacity:.4}
.bt-task-title{font-size:13px;line-height:18px;font-weight:500;overflow-wrap:anywhere}
.bt-task-prompt{font-size:12px;line-height:16px;color:var(--bt-ink-2);display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.bt-task-next{flex:none;font-size:12px;line-height:16px;color:var(--bt-ink-3);font-variant-numeric:tabular-nums;white-space:nowrap}
.bt-task-status{display:inline-flex;align-items:center;gap:6px;font-size:11px;line-height:18px;color:var(--bt-ink-2);max-width:100%;overflow-wrap:anywhere}
.bt-task-status::before{content:'';flex:none;width:6px;height:6px;border-radius:50%;background:var(--bt-ink-3)}
.bt-task-status[data-kind=completed]::before{background:var(--bt-green)}
.bt-task-status[data-kind=working]::before{background:var(--bt-accent)}
.bt-task-status[data-kind=failed]::before{background:var(--bt-danger)}
.bt-task-card{min-width:0}
.bt-task-card>.bt-task{padding:12px 16px}
.bt-task-card>.bt-task-detail{display:flex;flex-direction:column;gap:10px;padding:12px 16px;min-width:0}
.bt-task-progress{width:100%;height:4px;appearance:none;border:0;overflow:hidden;border-radius:999px;background:var(--bt-hover)}
.bt-task-progress::-webkit-progress-bar{background:var(--bt-hover)}
.bt-task-progress::-webkit-progress-value{background:var(--bt-accent);border-radius:999px}
.bt-task-progress::-moz-progress-bar{background:var(--bt-accent);border-radius:999px}
.bt-task-card[data-kind=completed] .bt-task-progress::-webkit-progress-value{background:var(--bt-ink-3)}
.bt-task-card[data-kind=completed] .bt-task-progress::-moz-progress-bar{background:var(--bt-ink-3)}
.bt-tasks-page{display:flex;flex-direction:column;gap:20px;min-width:0}
`
