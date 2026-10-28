import { defineTool } from '@deepseek-ai/dsh-tools'
import { output } from '../tools.js'

export function install(rt) {
  const register = tool => rt.ctx.tools.register(defineTool({ ...tool, output }))
  register({
    name: 'answer_durable_task',
    description: 'Record the direct user answer to an open question from this Bot\'s durable task. Continue the same saved task, never create a replacement or do the work in this chat. Use only the actual user answer; do not infer approval from an unrelated message, silence, or a task report. This records clarification, not permission to bypass DSH approval or change scope. Read the waiting question from your context or get_durable_task. Ask which one if ambiguous.',
    parameters: {
      key: { type: 'string', required: true, description: 'Existing task key belonging to this Bot' },
      question_id: { type: 'string', required: true, description: 'Exact id of the open question' },
      answer: { type: 'string', required: true, description: 'The user\'s answer, at most 6000 characters. Never collect credentials.' },
    },
    async execute(args, exec) { return JSON.stringify(await rt.answerDurableFromBot(args, exec)) },
  })
  register({
    name: 'create_durable_task',
    description: 'Start a user-requested task in saved stages from your own chat. Use for concrete work with several steps or work that should survive an application restart. You own this task. Its dedicated execution sessions use your model, working folder, supported permissions, instructions, a saved recent-chat/memory snapshot, read-only access to your own chat/memory, and your already attached MCP/skill capabilities. They cannot manage the team, change capabilities, create recursive tasks or install the application. Give each stage all relevant facts, full file paths and user constraints. Earlier stage results are passed to later stages. Return to the user after admission; progress and the final result come back automatically. Do not poll, sleep, repeat an admitted task, or perform the same work yourself. For a saved task whose setup failed, pass only its existing key to resume its original definition. Calling this does not authorize extra actions or keep running while the computer is off.',
    parameters: {
      title: { type: 'string', description: 'Short task name, at most 120 characters. Required for a new task.' },
      steps: { type: 'array', items: { type: 'string' }, description: '1 to 20 self-contained stages in execution order. Begin each stage with a short, clear heading on its own line; the chat progress card shows this heading. Put relevant facts, paths and the user\'s scope and permission constraints on the following lines. Required for a new task.' },
      key: { type: 'string', description: 'Existing task key, only to resume a saved task whose setup was interrupted. Omit title and steps when resuming. Never invent a key.' },
    },
    async execute(args, exec) {
      return JSON.stringify(await rt.createDurableFromBot(args, exec))
    },
  })
  register({
    name: 'cancel_durable_task',
    description: 'Stop this Bot chat\'s durable task when the user says stop, cancel, or do not continue. Call this directly in the chat, never delegate cancellation to a new task. Pass the existing key when the user identifies a task. Omit key only for the single unfinished task; if several match, ask which one. The result distinguishes cancelling, cancelled, completed, and needs_review. Do not say stopped until cancellation is confirmed. Completed external actions are not rolled back. You cannot stop work owned by another Bot chat.',
    parameters: { key: { type: 'string', description: 'Existing task key from this chat. Omit only when exactly one unfinished task exists.' } },
    async execute(args, exec) { return JSON.stringify(await rt.cancelDurableFromBot(args, exec)) },
  })
  for (const action of ['pause', 'resume']) register({
    name: `${action}_durable_task`,
    description: action === 'pause'
      ? 'Pause this Bot chat\'s durable task at its next saved step boundary when the user asks to pause or wait. The current admitted step finishes and saves first; do not claim a running tool is frozen. No later step starts while paused, including after restart. Use the existing task key when specified, or omit it only for a single matching task. Never create a new task to pause work.'
      : 'Continue this Bot chat\'s paused durable task when the user asks to continue or resume. Reuse the existing task and saved outputs; do not recreate it or repeat completed steps. This can also withdraw a pending pause. It cannot restart a cancelled, completed, failed or uncertain task. Omit key only for one paused task; ask which task when ambiguous.',
    parameters: { key: { type: 'string', description: 'Existing task key from this Bot chat. Omit only when a single matching task exists.' } },
    async execute(args, exec) { return JSON.stringify(await rt[action === 'pause' ? 'pauseDurableFromBot' : 'resumeDurableFromBot'](args, exec)) },
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
        completed: job.state.status === 'terminal' ? job.state.outcome.status === 'completed' ? job.stepCount : job.state.outcome.error?.completed ?? job.state.outcome.result?.length ?? 0 : job.state.checkpoint?.step ?? 0,
        ...(job.pauseRequested ? { pauseRequested: true, paused: job.paused } : {}),
        ...(job.cancelling ? { cancelling: true } : {}), ...(job.cancellation ? { cancellation: job.cancellation.status } : {}),
        ...(job.question ? { question: { id: job.question.id, question: job.question.question } } : {}),
        ...(job.state.status === 'terminal' ? { outcome: job.state.outcome.status } : {}),
      })) })
    },
  })
}
