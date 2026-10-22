import { randomUUID } from 'node:crypto'

const PHASES = new Set(['starting', 'waiting', 'thinking', 'responding', 'validating', 'done', 'error', 'aborted', 'tools'])

// Only fixed protocol phases and timestamps cross this channel, never CLI logs,
// prompts or partial schema payloads. Reasoning summaries use DSH's normal stream.
export function install(rt) {
  const runs = new Map()
  rt.ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/start' && runs.delete(session.id)) rt.notifyLive?.()
  })
  rt.cliProgressView = () => Object.fromEntries([...runs].map(([sessionId, value]) => [sessionId, value]))
  rt.beginCliProgress = (provider, options) => {
    const sessionId = options.sessionId
    if (!sessionId || options.purpose !== undefined) return () => {}
    const id = randomUUID()
    const previous = runs.get(sessionId)
    const startedAt = rt.live?.get(sessionId)?.since ?? (previous?.phase === 'tools' ? previous.startedAt : Date.now())
    const update = (phase) => {
      if (!PHASES.has(phase)) return
      const previous = runs.get(sessionId)
      if (phase !== 'starting' && previous?.id !== id) return
      if (previous?.id === id && previous.phase === phase) return
      const active = !['done', 'error', 'aborted', 'tools'].includes(phase)
      runs.set(sessionId, { id, provider, phase, active, startedAt, ...(!active ? { elapsedMs: Math.max(0, Date.now() - startedAt) } : {}) })
      rt.notifyLive?.()
    }
    update('starting')
    return update
  }
  rt.ctx.effect(() => () => runs.clear(), 'ds-bot: local CLI progress')
}
