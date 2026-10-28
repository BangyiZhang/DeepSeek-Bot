import { t } from './i18n.js'

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
  if (job.question) return { kind: 'waiting', label: 'Waiting for your answer', count, completed, results }
  if (job.pauseRequested) return { kind: 'pausing', label: 'Pausing after current step', count, completed, results }
  if (state.status === 'preparing') return { kind: 'preparing', label: 'Preparing task', count, completed: 0, results }
  if (state.status === 'missing') return { kind: 'review', label: 'Needs review', count, completed, results }
  return { kind: 'working', label: state.status === 'waiting' ? 'Waiting' : 'Working', count, completed, results }
}

export function durableTaskView(job) {
  const summary = durableTaskSummary(job)
  const delivery = job.notification?.status
  const reportNeedsReview = ['needs_reconciliation', 'unavailable'].includes(delivery)
  const awaitingReply = summary.kind === 'completed' && job.origin && !['delivered', 'needs_reconciliation', 'unavailable'].includes(delivery)
  const kind = reportNeedsReview ? 'review' : summary.kind
  const label = reportNeedsReview ? t('Needs review') : awaitingReply ? t('Waiting for Bot reply')
    : summary.kind === 'working' && summary.completed < summary.count
      ? t('Running step {number} of {count}', { number: summary.completed + 1, count: summary.count }) : t(summary.label)
  return { id: `durable:${job.key}`, source: 'durable', title: job.title || t('Untitled task'),
    subtitle: job.ownerName ? t('Managed by {name}', { name: job.ownerName }) : null,
    status: { kind, label } }
}
