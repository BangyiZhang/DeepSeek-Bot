import { t } from './i18n.js'

// Notifications for a window the user is not looking at (#1504): which events deserve
// one, what it may say, and the switches that keep it quiet. The shell decides whether
// the window is in front; this decides whether the event is the user's to see.

/** The stored switches: notifications on, and the conversations kept quiet. */
export const NOTIFY_KEY = 'ds-bot:notify'

/**
 * Whether a session status change deserves a notification.
 * @param {object} state
 * @param {{ running?: boolean, completionUnread?: boolean, pendingInteraction?: unknown }} [state.before]
 * @param {{ running?: boolean, completionUnread?: boolean, pendingInteraction?: unknown }} [state.after]
 * @param {boolean} state.viewing is the user looking at this conversation right now
 * @param {boolean} state.focused is the window in front
 * @param {boolean} state.enabled the global switch
 * @param {boolean} state.muted this conversation is muted
 * @param {boolean} state.group is this a group chat
 * @returns {'reply' | 'question' | undefined} what to say, or undefined for nothing
 */
export function notifyKind({ before, after, viewing, focused, enabled, muted, group }) {
  if (before === undefined || enabled !== true || muted === true) return undefined
  // The user is looking at this conversation in a focused window: the screen already says it.
  if (viewing === true && focused === true) return undefined
  const wasPending = before?.pendingInteraction !== undefined
  const isPending = after?.pendingInteraction !== undefined
  if (isPending && (!wasPending || after.pendingInteraction !== before.pendingInteraction)) return 'question'
  // A group says nothing for an ordinary reply: only what waits on the user is worth a
  // system notification there. @-mentions are #945's, later on this same channel.
  if (group === true) return undefined
  if (after?.completionUnread === true && before?.completionUnread !== true) return 'reply'
  return undefined
}

/**
 * What a notification may say: the conversation's name and one short line. The body goes
 * to a lock screen, so it never carries the message itself (#1504).
 * @param {{ title: string, kind: 'reply' | 'question' }} notice
 * @returns {{ title: string, body: string }}
 */
export function noticeText({ title, kind }) {
  const name = String(title ?? '').trim().slice(0, 60)
  const body = t(kind === 'question' ? 'Waiting for your answer' : 'A new reply is waiting')
  return { title: name === '' ? 'DS Bot' : name, body }
}

/**
 * The switches as stored, with the defaults: on, nothing muted.
 * @param {string | null} raw what localStorage holds
 * @returns {{ enabled: boolean, muted: Record<string, true> }}
 */
export function readNotifyPrefs(raw) {
  try {
    const value = JSON.parse(raw ?? 'null')
    if (value === null || typeof value !== 'object') return { enabled: true, muted: {} }
    const muted = value.muted !== null && typeof value.muted === 'object' ? Object.fromEntries(Object.entries(value.muted).filter(([, on]) => on === true)) : {}
    return { enabled: value.enabled !== false, muted }
  } catch {
    return { enabled: true, muted: {} }
  }
}

/**
 * The switches to store after one change.
 * @param {{ enabled: boolean, muted: Record<string, true> }} prefs
 * @param {{ enabled?: boolean, mute?: { id: string, on: boolean } }} change
 * @returns {{ enabled: boolean, muted: Record<string, true> }}
 */
export function writeNotifyPrefs(prefs, change) {
  const enabled = typeof change.enabled === 'boolean' ? change.enabled : prefs.enabled
  const muted = { ...prefs.muted }
  if (change.mute !== undefined) {
    if (change.mute.on === true) muted[change.mute.id] = true
    else delete muted[change.mute.id]
  }
  return { enabled, muted }
}

/**
 * How many conversations carry something new, for the dock badge: unread replies and
 * cards waiting on the user.
 * @param {Array<{ unread?: boolean, pending?: boolean }>} rows
 * @returns {number}
 */
export function badgeOf(rows) {
  let count = 0
  for (const row of rows ?? []) if (row.unread === true || row.pending === true) count += 1
  return count
}


export function notificationRows({ statuses, roster, approvals = [] }) {
  const rows = []
  for (const [group, entries] of [[false, roster.bots ?? []], [true, roster.rooms ?? []]]) {
    for (const entry of entries) {
      const sessionId = entry.sessionId ?? entry.id
      const status = statuses?.get(sessionId)
      const question = roster.questions?.[sessionId]
      const waiting = approvals.filter(approval => group ? approval.roomId === entry.id : approval.roomId === undefined && approval.botId === entry.id)
      const interaction = status?.pendingInteraction
      const keys = [
        ...(question ? [`question:${question.id}`] : []),
        ...waiting.map(approval => `approval:${approval.id}`),
        ...(interaction !== undefined ? [`interaction:${interaction?.id ?? interaction?.kind ?? 'pending'}`] : []),
      ].sort()
      // Every conversation gets a row, quiet ones too: DSH has no status for a Session
      // until something happens there, and a row that first appears with an approval
      // would read as one that was already waiting.
      rows.push({
        id: entry.id, sessionId, name: entry.name, group,
        unread: status?.completionUnread === true, pending: keys.length > 0,
        status: { ...status, pendingInteraction: keys.length > 0 ? keys.join('|') : undefined },
      })
    }
  }
  return rows
}

/**
 * The notifications one new snapshot calls for, and the snapshot to compare the next one with.
 * @param {object} state
 * @param {Map<string, object> | null} state.previous the last snapshot, null before the first
 * @param {ReturnType<typeof notificationRows>} state.rows
 * @param {string | null} state.viewing the Session on screen
 * @param {boolean} state.focused is the window in front
 * @param {{ enabled: boolean, muted: Record<string, true> }} state.prefs
 * @returns {{ notices: Array<{ sessionId: string, title: string, body: string }>, next: Map<string, object> }}
 */
export function noticesFor({ previous, rows, viewing, focused, prefs }) {
  const notices = []
  const next = new Map()
  for (const { id, sessionId, name, group, status: after } of rows) {
    next.set(id, after)
    const kind = notifyKind({
      before: previous?.get(id), after,
      viewing: viewing === sessionId, focused,
      enabled: prefs.enabled, muted: prefs.muted[id] === true, group,
    })
    if (kind !== undefined) notices.push({ sessionId: id, ...noticeText({ title: name, kind }) })
  }
  return { notices, next }
}
