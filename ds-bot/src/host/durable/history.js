const MAX_EVENTS = 256

export function addTaskEvent(job, type, { id, step, tool } = {}) {
  job.events ??= []
  if (id && job.events.some(event => event.id === id)) return
  job.eventSequence = (job.eventSequence ?? 0) + 1
  job.events.push({ id: id ?? `event-${job.eventSequence}`, type, at: Date.now(), ...(Number.isInteger(step) ? { step } : {}), ...(tool ? { tool } : {}) })
  if (job.events.length > MAX_EVENTS) {
    job.events.shift()
    job.omittedEvents = (job.omittedEvents ?? 0) + 1
  }
}

export function taskHistory(record, sessions = [], redact = value => value) {
  const terminal = record?.state?.status === 'terminal' || record?.abortRequested
  return {
    events: (record?.events ?? []).map(({ id, type, at, step, tool }) => ({ id, type, at, ...(Number.isInteger(step) ? { step } : {}), ...(tool ? { tool: redact(tool) } : {}) })),
    omittedEvents: record?.omittedEvents ?? 0,
    questions: (record?.questions ?? []).map(question => ({
      id: question.id, step: sessions.indexOf(question.sessionId), question: redact(question.question), detail: redact(question.detail ?? ''),
      options: (question.options ?? []).map(option => ({ label: redact(option.label), ...(option.description ? { description: redact(option.description) } : {}) })),
      askedAt: question.askedAt, status: question.answer !== undefined ? 'answered' : terminal ? 'closed' : 'waiting',
      ...(question.answer !== undefined ? { answer: redact(question.answer), answeredAt: question.answeredAt } : {}),
    })),
  }
}
