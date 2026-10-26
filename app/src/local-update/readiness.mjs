// Only documented Harness services and our plugin's own queues participate.
export async function updateReadiness(ctx) {
  const agents = ctx.get('agents')
  const jobs = ctx.get('jobs')
  const bots = ctx.get('dsBotDesktopUpdates')
  if (!agents?.list || !jobs?.list || !bots?.readiness) return { idle: false, reason: 'Readiness services are unavailable' }
  const team = await bots.readiness()
  const active = agents.list().filter(agent => agent.status !== 'idle' || !agent.inbox
    || agent.inbox.nextStep.length > 0 || agent.inbox.nextTurn.length > 0)
  const work = jobs.list().filter(job => !['completed', 'killed', 'failed'].includes(job.status))
  return { idle: team.idle && active.length === 0 && work.length === 0, agents: active.length, jobs: work.length, team }
}
