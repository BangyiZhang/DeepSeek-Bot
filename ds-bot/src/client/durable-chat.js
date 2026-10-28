import { createElement as h, useEffect, useState } from 'react'
import { call } from './api.js'
import { durableTaskSummary, durableTaskView } from './durable-task-view.js'
import { TaskCard, TaskProgress } from './task-ui.js'
import { DurablePlan } from './durable-plan.js'
import { DurableHistory } from './durable-history.js'
import { hostText, t } from './i18n.js'

export function durableAdmission(content) {
  try {
    const value = JSON.parse(content)
    return typeof value?.key === 'string' && /^[a-zA-Z0-9_.-]{1,100}$/.test(value.key) ? value : null
  } catch { return null }
}

export function DurableChatTask({ admission, title, stepCount, steps, actions }) {
  const [job, setJob] = useState(null)
  const [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    let timer
    const tick = async () => {
      try {
        const view = await call('durable-state', { key: admission.key }, controller.signal)
        if (controller.signal.aborted) return
        const current = view.jobs?.find(entry => entry.key === admission.key)
        setJob(current ?? { title, stepCount, state: { status: 'missing' } })
        setError('')
        const terminal = current?.state?.status === 'terminal'
        const delivery = current?.notification?.status
        if (!current || (terminal && (!current.origin || ['delivered', 'needs_reconciliation', 'unavailable'].includes(delivery)))) return
      } catch (failure) {
        if (controller.signal.aborted) return
        setError(failure?.message ?? String(failure))
      }
      timer = setTimeout(tick, document.hidden ? 5000 : 1500)
    }
    void tick()
    return () => { controller.abort(); clearTimeout(timer) }
  }, [admission.key, refresh])
  const summary = durableTaskSummary(job ?? { stepCount: stepCount ?? steps?.length ?? 0, state: { status: 'preparing' } })
  const notification = job?.notification
  const reportNeedsReview = ['needs_reconciliation', 'unavailable'].includes(notification?.status)
  const view = durableTaskView({ key: admission.key, title: title ?? admission.title,
    ...(job ?? { stepCount: stepCount ?? steps?.length ?? 0, state: { status: 'preparing' } }) })
  return h(TaskCard, { task: view, className: 'bt-durable-chat', label: t('Durable task') },
    h(TaskProgress, { count: summary.count, completed: summary.completed }),
    h(DurablePlan, { job, summary, steps }),
    job ? h(DurableHistory, { job, summary }) : null,
    summary?.kind === 'pausing' ? h('p', null, t('The current step will finish and save before pausing.')) : summary?.kind === 'paused' ? h('p', null, t('Saved progress is kept. Say “continue” in this Bot chat to resume.')) : null,
    reportNeedsReview ? h('p', null, t('The result is saved. Check task details because its return to this chat could not be confirmed.')) : null,
    summary?.kind === 'review' ? h('p', null, t(summary.stopUnconfirmed ? 'Stopping could not be confirmed. This task may still be running. Check its work chat.' : 'Execution stopped at an uncertain step. Check the work chat before repeating an action.')) : null,
    error ? h('p', { className: 'bt-error', role: 'status' }, hostText(error)) : null,
    h('div', { className: 'bt-durable-chat-actions' },
      h('button', { type: 'button', className: 'bt-mini', onClick: () => actions.openSettings?.('durable') }, t('View task')),
      error ? h('button', { type: 'button', className: 'bt-mini', onClick: () => setRefresh(value => value + 1) }, t('Refresh')) : null))
}
