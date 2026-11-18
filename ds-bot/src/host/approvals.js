// Approvals. A member's group Session is hidden, so DSH's approval card never shows
// there and the turn would wait forever: DS Bot answers those requests itself, from
// the group chat. A Bot's own chat keeps DSH's card, but DS Bot can answer those too
// (IM chats, the phone app): the request is raced — whichever side answers first wins,
// and the other card withdraws.
// The user's "Always allow" rules answer a request before any card shows, and a request
// nobody answers is rejected after the team's timeout, so a Bot never waits forever
// (docs/plans/2026-11-18-approval-rules.md).
import { randomUUID } from 'node:crypto'
import { addRule, askOf, offerOf, ruleCovers, timeoutMinutes } from './approval-rules.js'

const OUTCOMES = { allow: 'allowed-once', reject: 'rejected' }

export function install(rt) {
  const { ctx, state } = rt
  /** @type {Map<string, {id:string, sessionId:string, botId:string, roomId?:string, tool:string, reason:string, detail:{text?:string, code?:string}, at:number, answer?:(outcome:string)=>void}>} */
  const pending = new Map()
  // Requests rejected for want of an answer, shown for a while so the user sees why.
  const EXPIRED_SHOWN_MS = 30 * 60_000
  let expired = []
  const approvalListeners = new Set()
  const onApproval = (listener) => {
    approvalListeners.add(listener)
    return () => approvalListeners.delete(listener)
  }
  const emit = (kind, data) => {
    for (const listener of approvalListeners) {
      try { listener(kind, data) } catch (error) { rt.warn('ds-bot: approval listener failed: %s', error) }
    }
  }

  // The ask with real paths, or undefined when one lies in DSH's or the team's data,
  // which no rule may open.
  async function realAsk(ask) {
    const paths = await Promise.all(ask.paths.map(path => rt.realBeyond(path)))
    for (const path of paths) if (await rt.inData(path)) return undefined
    return { kind: 'paths', paths }
  }

  // Ahead of DSH's own answerer, which would hold a hidden Session's request unseen.
  // Without a rule to check against the disk, the request is taken at once, as before.
  ctx.on('approval/request', (request, next) => {
    const sessionId = request.agent?.session?.id ?? request.agent?.id
    const owner = sessionId === undefined ? undefined : rt.groupOwners.get(sessionId)
    const task = rt.durableOwnerOf?.(sessionId)
    const botId = owner?.botId ?? task?.botId ?? (sessionId === undefined ? undefined : rt.chatOwners.get(sessionId))
    if (botId === undefined) return next()
    const ask = askOf(String(request.toolName ?? ''), rt.callArgs?.(sessionId, request.callId) ?? {}, rt.sessionFolder?.(request.agent?.session))
    const where = { sessionId, owner, task, botId, offer: offerOf(ask) }
    const rules = rt.botOf?.(botId)?.approvalRules ?? []
    if (ask === undefined || rules.length === 0) return waitFor(request, next, where)
    if (ask.kind === 'command') return rules.some(rule => ruleCovers(rule, ask)) ? 'allowed-once' : waitFor(request, next, where)
    return realAsk(ask).catch(() => undefined).then(real => (real !== undefined && rules.some(rule => ruleCovers(rule, real)) ? 'allowed-once' : waitFor(request, next, where)))
  }, { prepend: true })

  function waitFor(request, next, { sessionId, owner, task, botId, offer }) {
    const id = randomUUID()
    const entry = {
      id,
      sessionId,
      botId,
      ...(owner ? { roomId: owner.roomId } : {}),
      ...(task ? { durable: true } : {}),
      tool: String(request.toolName ?? ''),
      ...(typeof request.callId === 'string' ? { callId: request.callId } : {}),
      reason: String(request.reason ?? '').slice(0, 500),
      detail: rt.callDetail?.(sessionId, request.callId) ?? {},
      ...(offer ? { offer } : {}),
      at: Date.now(),
    }
    const minutes = timeoutMinutes(state?.prefs)
    if (minutes > 0) entry.expiresAt = entry.at + minutes * 60_000
    pending.set(id, entry)
    rt.noteApproval?.(sessionId, { tool: entry.tool, reason: entry.reason.slice(0, 200) })
    rt.approvalWaiting?.(entry)
    emit('open', { ...entry, answerable: true })
    let timer
    const settle = (outcome) => {
      if (!pending.has(id)) return false
      pending.delete(id)
      clearTimeout(timer)
      rt.noteApproval?.(sessionId, undefined)
      emit('settled', { id, outcome, ...(entry.expired ? { expired: true } : {}) })
      if (entry.expired) {
        const { answer: _answer, ...shown } = entry
        expired = [...expired.filter(old => Date.now() - old.expiredAt < EXPIRED_SHOWN_MS), { ...shown, expiredAt: Date.now() }].slice(-20)
      }
      return true
    }
    // Rejected, never allowed: a Bot that nobody answers goes on without the step.
    if (entry.expiresAt !== undefined) {
      timer = setTimeout(() => {
        entry.expired = true
        entry.answer?.('rejected')
      }, entry.expiresAt - entry.at)
      timer.unref?.()
    }
    if (owner === undefined && task === undefined) {
      // An own-chat approval races DSH's card. The card sees `linked`, our own
      // AbortSignal: answering here resolves the request, then withdraws the card;
      // an answer there settles `next()` first and is adopted. An abort of the
      // original signal cancels either way.
      const original = request.signal
      const linked = new AbortController()
      request.signal = linked.signal
      return new Promise((resolve, reject) => {
        const complete = (outcome) => {
          if (!settle(outcome)) return
          resolve(outcome)
          linked.abort()
          if (request.signal === linked.signal) request.signal = original
        }
        entry.answer = complete
        if (original?.aborted) entry.answer('cancelled')
        else original?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
        Promise.resolve(next()).then(
          (outcome) => {
            if (!pending.has(id)) return
            complete(outcome)
          },
          // DSH's answerer threw: close the entry and give the caller the error
          // the way the pre-race code did, instead of hanging forever.
          (error) => {
            if (!settle('cancelled')) return
            reject(error)
            linked.abort()
            if (request.signal === linked.signal) request.signal = original
          },
        )
      })
    }
    rt.yieldRoomTurn?.(sessionId)
    return new Promise((resolve) => {
      entry.answer = (outcome) => {
        if (!settle(outcome)) return
        resolve(outcome)
      }
      if (request.signal?.aborted) entry.answer('cancelled')
      request.signal?.addEventListener('abort', () => entry.answer('cancelled'), { once: true })
    })
  }

  const approvalsView = () => [...pending.values()].map(({ answer, ...entry }) => ({ ...entry, answerable: answer !== undefined }))
  const expiredApprovalsView = () => expired.filter(entry => Date.now() - entry.expiredAt < EXPIRED_SHOWN_MS)
  const waitsForApproval = sessionId => [...pending.values()].some(entry => entry.sessionId === sessionId)

  function answerApproval(id, choice) {
    const entry = pending.get(String(id ?? ''))
    if (entry?.answer === undefined) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
    const outcome = OUTCOMES[choice]
    if (outcome === undefined) throw Object.assign(new Error('Choose allow or reject'), { code: 'bot/invalid' })
    entry.answer(outcome)
  }

  // "Always allow": the Bot keeps a rule for what this request asks, and this one is
  // allowed. A folder is saved as its real path and may neither lie in nor hold DSH's or
  // the team's data.
  async function allowAlways(id) {
    const entry = pending.get(String(id ?? ''))
    if (entry?.answer === undefined) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
    const bot = rt.botOf(entry.botId)
    let offer = entry.offer
    if (offer?.kind === 'folder') {
      const folder = await rt.realBeyond(offer.folder)
      offer = await rt.guarded(folder) ? undefined : { kind: 'folder', folder }
    }
    if (offer === undefined || bot === undefined) throw Object.assign(new Error('This approval cannot be allowed always'), { code: 'bot/invalid' })
    if (!pending.has(entry.id)) throw Object.assign(new Error('This approval is no longer open'), { code: 'bot/stale' })
    bot.approvalRules = addRule(bot.approvalRules, offer)
    entry.answer('allowed-once')
    await rt.save()
  }

  // The user takes a rule back; the next request it covered asks again.
  async function removeApprovalRule(botId, ruleId) {
    const bot = rt.botOf(String(botId ?? ''))
    if (bot === undefined) throw Object.assign(new Error('There is no such Bot'), { code: 'bot/invalid' })
    const rules = bot.approvalRules ?? []
    const kept = rules.filter(rule => rule.id !== ruleId)
    if (kept.length === rules.length) return false
    if (kept.length === 0) delete bot.approvalRules
    else bot.approvalRules = kept
    await rt.save()
    return true
  }

  // A group Session that leaves its group has no card left to answer from.
  const cancelApprovals = (sessionId) => {
    for (const entry of pending.values()) {
      if (entry.sessionId === sessionId) entry.answer?.('cancelled')
    }
  }

  Object.assign(rt, { approvalsView, expiredApprovalsView, waitsForApproval, answerApproval, allowAlways, removeApprovalRule, cancelApprovals, onApproval })
}
