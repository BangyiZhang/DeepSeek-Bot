import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from '../tools.js'

export function install(rt) {
  const register = tool => rt.ctx.tools.register(defineTool({ ...tool, output }))
  register({
    name: 'create_durable_task',
    description: 'Start a user-requested task in saved stages from your own chat. Use for concrete work with several steps or work that should survive an application restart. The worker uses your current model, working folder, configured permission preset and Bot instructions; it cannot see this conversation, manage the team, or use Bot-attached capabilities. Give each stage all relevant facts, full file paths and user constraints. Earlier stage results are passed to later stages. Return to the user after admission; progress and the final result come back automatically. Do not poll, sleep, repeat an admitted task, or perform the same work yourself. For a saved task whose setup failed, pass only its existing key to resume its original definition. Calling this does not authorize extra actions or keep running while the computer is off.',
    parameters: {
      title: { type: 'string', description: 'Short task name, at most 120 characters. Required for a new task.' },
      steps: { type: 'array', items: { type: 'string' }, description: '1 to 20 self-contained stages in execution order. Required for a new task. Keep the user\'s scope and permission constraints in each relevant stage.' },
      key: { type: 'string', description: 'Existing task key, only to resume a saved task whose setup was interrupted. Omit title and steps when resuming. Never invent a key.' },
    },
    async execute(args, exec) {
      return JSON.stringify(await rt.createDurableFromBot(args, exec))
    },
  })
  register({
    name: 'get_durable_task',
    description: 'Read a saved task belonging to this Bot\'s own chat. Use when the user asks about its progress or when checking a task after a restart; do not repeatedly poll. It reports saved outputs and any need for manual review. It does not restart or retry the work.',
    parameters: { key: { type: 'string', required: true, description: 'Existing durable task key returned by create_durable_task or list_durable_tasks' } },
    async execute(args, exec) {
      const value = await rt.durableStateForBot({ key: args.key }, exec)
      return JSON.stringify(value.jobs[0])
    },
  })
  register({
    name: 'list_durable_tasks',
    description: 'List saved tasks created from this Bot\'s own chat. Use to find an existing task before considering another one, or when the user asks what is running. Work owned by other Bot chats is not visible.',
    parameters: {},
    async execute(_args, exec) {
      const value = await rt.durableStateForBot({}, exec)
      return JSON.stringify({ ...value, total: value.jobs.length, jobs: value.jobs.slice(-50).reverse().map(job => ({
        key: job.key, title: job.title, stepCount: job.stepCount, status: job.state.status,
        completed: job.state.status === 'terminal' ? job.state.outcome.status === 'completed' ? job.stepCount : job.state.outcome.error?.completed ?? 0 : job.state.checkpoint?.step ?? 0,
        ...(job.state.status === 'terminal' ? { outcome: job.state.outcome.status } : {}),
      })) })
    },
  })
}
