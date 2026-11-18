// "Always allow" and the approval timeout, as the user sees them
// (docs/plans/2026-11-18-approval-rules.md): the button and countdown on a card, a strip
// inside the card DSH draws for a Bot's own chat, and the Bot's saved rules.
import { createElement as h, Fragment, useEffect, useState } from 'react'
import { t } from './i18n.js'
import { freePriority } from './surface.js'

// Kept in step with src/host/approval-rules.js, which the client cannot import.
export const APPROVAL_TIMEOUTS = [0, 5, 10, 30, 60]
const TIMEOUT_DEFAULT_MIN = 10
export const approvalTimeoutOf = prefs => (APPROVAL_TIMEOUTS.includes(prefs?.approvalTimeout) ? prefs.approvalTimeout : TIMEOUT_DEFAULT_MIN)

/** What a rule or an offer covers, in a few words; the full path or command is its title. */
export function scopeText(scope) {
  if (scope?.kind === 'folder') return { label: t('Files in {folder}', { folder: scope.folder }), title: scope.folder }
  if (scope?.kind === 'command') return { label: t('The command {command}', { command: scope.command }), title: scope.command }
  return { label: '', title: '' }
}

/** "Rejects automatically in 4 min", ticking each half minute. */
export function Countdown({ until }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (typeof until !== 'number') return undefined
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [until])
  if (typeof until !== 'number') return null
  const minutes = Math.max(1, Math.ceil((until - now) / 60_000))
  return h('div', { className: 'bt-ap-countdown' }, t('No answer: rejected automatically in {n} min', { n: minutes }))
}

export function AlwaysButton({ approval, busy, answer }) {
  if (!approval.offer) return null
  const { title } = scopeText(approval.offer)
  const label = approval.offer.kind === 'folder' ? t('Always allow this folder') : t('Always allow this command')
  return h('button', { type: 'button', className: 'bt-q-btn', disabled: busy, title, 'aria-label': label, onClick: () => answer('always') }, label)
}

// Inside DSH's approval card in a Bot's own chat (its `conversation.approval.detail`
// slot): DSH draws that card, so "Always allow" and the countdown sit in it. An answer
// here settles the request, and DSH's card goes away with it.
export function ApprovalDetail({ sessionId, callId, useWork, actions }) {
  const approval = useWork(value => (value.approvals ?? []).find(entry => entry.callId === callId && entry.sessionId === sessionId && entry.roomId === undefined && !entry.durable))
  const [busy, setBusy] = useState(false)
  if (!approval || (!approval.offer && !approval.expiresAt)) return null
  const answer = (choice) => {
    setBusy(true)
    void Promise.resolve(actions.answerApproval(approval.id, choice))
      .catch(error => actions.reportError(error, 'approval'))
      .finally(() => setBusy(false))
  }
  return h('div', { className: 'bt-ap-strip' },
    h('div', { className: 'bt-ap-copy' },
      approval.offer ? h('div', { className: 'bt-ap-scope', title: scopeText(approval.offer).title }, scopeText(approval.offer).label) : null,
      h(Countdown, { until: approval.expiresAt })),
    h(AlwaysButton, { approval, busy, answer }))
}

// The detail slot is single and DSH's chat already fills it with the call's command, so
// DS Bot's entry draws that one first and its strip after it, the way the session header
// keeps DSH's navigation (header-navigation.js).
const DETAIL = 'conversation.approval.detail'
let shippedDetail
function DetailWithRule(props) {
  return h(Fragment, null, shippedDetail ? h(shippedDetail, props) : null, h(ApprovalDetail, props))
}
export function installApprovalDetail(slots, face, priority) {
  let dispose
  const refresh = () => {
    const entries = slots.entries(DETAIL).filter(entry => entry.component !== DetailWithRule)
    const shipped = [...entries].sort((a, b) => (a.options?.priority ?? 0) - (b.options?.priority ?? 0))[0]?.component
    if (dispose && shipped === shippedDetail) return
    dispose?.()
    shippedDetail = shipped
    dispose = slots.register({ name: DETAIL, priority: freePriority(entries, { priority }), inject: face }, DetailWithRule)
  }
  const unsubscribe = slots.subscribe(DETAIL, refresh)
  try { refresh() } catch (error) { unsubscribe(); throw error }
  return () => { unsubscribe(); dispose?.() }
}

// Above the composer of a Bot's own chat, once DSH's card is gone: why the Bot went on
// without the step.
export function ExpiredApprovalDock({ sessionId, useRoster, useWork }) {
  const bot = useRoster(value => value.byId[sessionId])
  const expired = useWork(value => value.expiredApprovals ?? [])
  if (!bot) return null
  const last = expired.filter(entry => entry.botId === bot.id && entry.roomId === undefined).at(-1)
  if (!last) return null
  return h('div', { className: 'bt-q-dock' },
    h('div', { className: 'bt-ap-strip bt-ap-expired', role: 'status' },
      h('div', { className: 'bt-ap-copy' }, t('No one answered the approval for {tool}, so it was rejected and {name} went on without it.', { tool: last.tool, name: bot.name }))))
}

// The Bot's rules, under its permissions in its details.
export function ApprovalRules({ bot, actions, run }) {
  const rules = bot.approvalRules ?? []
  if (!rules.length) return null
  return h('div', { className: 'bt-ap-rules' },
    h('div', { className: 'bt-ap-rules-title' }, t('Always allowed')),
    rules.map(rule => h('div', { key: rule.id, className: 'bt-ap-rule' },
      h('span', { className: 'bt-ap-scope', title: scopeText(rule).title }, scopeText(rule).label),
      h('button', { type: 'button', className: 'bt-soft bt-soft-sm', onClick: () => run(actions.removeApprovalRule(bot.id, rule.id)) }, t('Remove')))))
}

export const APPROVAL_RULES_CSS = `
.bt-ap-strip{display:flex;align-items:center;gap:10px;margin:8px 0 0;font-family:var(--bt-font);white-space:normal;padding:8px 12px;border-radius:12px;background:var(--bt-hover);font-size:12px;line-height:17px;color:var(--bt-ink-2)}
.bt-ap-strip>button{flex:none;height:28px;padding:0 12px;font-size:12px}
.bt-ap-strip>button:disabled{opacity:.5;cursor:default}
.bt-ap-copy{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.bt-ap-scope{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--bt-ink)}
.bt-ap-countdown{color:var(--bt-ink-3)}
.bt-q-dock>.bt-ap-expired{margin:0 auto 8px;color:var(--bt-ink-3)}
.bt-ap-rules{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.bt-ap-rules-title{font-size:12px;color:var(--bt-ink-3)}
.bt-ap-rule{display:flex;align-items:center;gap:8px;font-size:12px}
.bt-ap-rule>.bt-ap-scope{flex:1;min-width:0}
`
