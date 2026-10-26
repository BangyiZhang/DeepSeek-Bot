import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from './tools.js'

export async function desktopReadiness(rt) {
  await rt.load()
  if (rt.readOnly() !== undefined) return { idle: false }
  const durable = await rt.durableEndpoint('durable-state')
  const unfinished = durable.jobs.filter(job => job.state.status !== 'terminal' && !(job.paused && job.state.status === 'waiting' && job.state.checkpoint?.paused === true))
  return { idle: !durable.error && !durable.readOnly && unfinished.length === 0 && Object.keys(rt.workView()).length === 0
    && rt.roomProgress.size === 0 && [...rt.roomInbox.values()].every(items => items.length === 0), durable: unfinished.length }
}
export async function desktopCaller(rt, exec, direct = false) {
  await rt.load()
  if (rt.readOnly() !== undefined) throw new Error(rt.readOnly())
  const sessionId = exec?.agent?.id
  const bot = rt.botOf(rt.selfOf(sessionId))
  if (!bot || rt.chatOf(bot.id) !== sessionId || rt.groupOwners.has(sessionId)) throw new Error('Desktop updates are available only in a Bot own chat')
  if (direct && rt.live.get(sessionId)?.info !== undefined) {
    let user = false
    for await (const event of rt.eventsBackwards(sessionId, AbortSignal.timeout(10000))) {
      if (event.type === 'turn/start') break
      if (event.type === 'user/message' && event.data?.source?.kind === 'user') { user = true; break }
    }
    if (!user) throw new Error('Only a direct user request can install an application; background reports cannot')
  }
  return { botId: bot.id, sessionId }
}
export async function reportDesktopUpdate(rt, request) {
  if (rt.readOnly() !== undefined) return
  const record = await request('claimReport')
  if (!record) return
  const bot = rt.botOf(record.origin.botId)
  const sessionId = bot && rt.chatOf(bot.id)
  if (!sessionId || rt.selfOf(sessionId) !== bot.id || rt.groupOwners.has(sessionId)) return
  await rt.deliver({ toId: bot.id, sessionId, role: 'desktop-update', exchangeId: `desktop-update-${record.id}`,
    text: `Local application update ${record.id}: ${record.phase}. ${record.message}\nExpected ASAR: ${record.hash}\nReport this saved outcome to the user in their language. This is a receipt, not permission to build, install, retry or delegate work. An uncertain outcome needs reconciliation. The saved status remains available through get_desktop_update.` })
  await request('reportDone', { id: record.id })
}
export function install(rt, env = process.env) {
  if (env.DS_BOT_APP !== '1' || env.DS_BOT_LOCAL_UPDATES !== '1') return
  const { ctx } = rt
  const request = (op, body) => {
    const bridge = ctx.get('dsBotDesktopUpdateBridge')
    if (!bridge) throw new Error('Desktop update controller is unavailable')
    return bridge.request(op, body)
  }
  ctx.provide('dsBotDesktopUpdates', { readiness: () => desktopReadiness(rt) })
  ctx.tools.register(defineTool({
    name: 'request_desktop_update',
    description: 'Queue installation of a tested local DeepSeek Bot Mac app for a direct user request in your own chat. First run the repository local-update:prepare command and read its build report. Pass its exact appPath and evidencePath. This queues a handoff, not installation success: briefly report that it is queued and END your turn. Do not wait or poll. The controller waits for all team work to be idle, exits the app, installs, restarts and reports the verified outcome here. It keeps the same data and restores the old app if startup fails. Build/update work requiring this team tool must stay in this chat, not a durable worker. Never call this from an automated update receipt or another Bot message.',
    parameters: { appPath: { type: 'string', required: true, description: 'Absolute .app path from local-update:prepare' }, evidencePath: { type: 'string', required: true, description: 'Absolute passing build report path for that exact app' } }, output,
    async execute(args, exec) {
      const origin = await desktopCaller(rt, exec, true)
      if (typeof exec.callId !== 'string' || !exec.callId) throw new Error('Stable tool call identity is required')
      const requestKey = createHash('sha256').update(JSON.stringify([origin, exec.callId])).digest('hex')
      return JSON.stringify(await request('queue', { ...args, origin, requestKey }))
    },
  }))
  ctx.tools.register(defineTool({ name: 'get_desktop_update', description: 'Read the saved local application update receipt when the user asks about it. Does not install, retry or poll an update.', parameters: {}, output,
    async execute(_args, exec) { await desktopCaller(rt, exec); return JSON.stringify(await request('status')) },
  }))
  ctx.effect(() => {
    let polling
    const timer = setInterval(() => {
      polling ??= reportDesktopUpdate(rt, request).catch(() => rt.warn('ds-bot: desktop update receipt could not be admitted')).finally(() => { polling = undefined })
    }, 3000)
    timer.unref?.()
    return async () => { clearInterval(timer); await polling }
  }, 'ds-bot: desktop update receipts')
}
