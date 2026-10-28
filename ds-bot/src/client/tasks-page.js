import { createElement as h } from 'react'
import { Segmented } from './motion.js'
import { SchedulesPage } from './schedules.js'
import { DurableTasksPage } from './durable-tasks.js'
import { t } from './i18n.js'

// Keep old links (including Bot-specific schedule creation) addressable.
export function taskPageRoute(page, id) {
  return { section: page === 'durable' || page === 'tasks' && id === 'saved' ? 'saved' : 'scheduled',
    start: page === 'schedules' ? id : undefined }
}

export function TasksPage({ page, id, roster, actions }) {
  const { section, start } = taskPageRoute(page, id)
  return h('div', { className: 'bt-tasks-page' },
    h(Segmented, { label: t('Task type'), value: section },
      [['scheduled', 'Scheduled tasks'], ['saved', 'Saved progress']].map(([key, label]) => h('button', {
        key, type: 'button', 'aria-pressed': section === key, onClick: () => actions.openSettings('tasks', key),
      }, t(label)))),
    section === 'scheduled' ? h(SchedulesPage, { key: `scheduled:${start ?? ''}`, roster, actions, start })
      : h(DurableTasksPage, { roster, actions }))
}
