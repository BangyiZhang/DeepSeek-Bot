import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CommonActions, StackRouter, type NavigationAction } from '@react-navigation/routers'
import { activeChatTarget, listLaunchState, openChat } from './open-chat.ts'

const ROUTE_NAMES = ['Chat', 'BotDetails', 'BotEdit', 'GroupDetails', 'GroupSettings', 'Memory', 'Settings', 'Needs', 'NewBot', 'NewGroup']
const SETTINGS_NAMES = ['SettingsHome', 'Computers', 'Providers']
const OPTIONS = {
  routeNames: ROUTE_NAMES,
  routeParamList: {},
  routeGetIdList: {},
}
const SETTINGS_OPTIONS = {
  routeNames: SETTINGS_NAMES,
  routeParamList: {},
  routeGetIdList: {},
}

// Simulates NavigationContainerRef outside Stack.Navigator: exposes dispatch and
// CommonActions, never StackActions methods like popTo, and bubbles unhandled
// child-stack actions up to the root stack router.
function createContainer(initialParams?: { kind: 'bot' | 'room'; id: string }) {
  const rootRouter = StackRouter({})
  const settingsRouter = StackRouter({})
  let state = rootRouter.getInitialState(OPTIONS)
  if (initialParams !== undefined) {
    state = { ...state, routes: [{ ...state.routes[0], params: initialParams }] }
  }
  return {
    getState: () => state,
    dispatch(action: NavigationAction) {
      const top = state.routes[state.index]
      if (top.name === 'Settings' && top.state !== undefined) {
        const nextChild = settingsRouter.getStateForAction(top.state as any, action as any, SETTINGS_OPTIONS)
        if (nextChild !== null) {
          const fullChild = settingsRouter.getRehydratedState(nextChild, SETTINGS_OPTIONS)
          state = {
            ...state,
            routes: state.routes.map((route, i) => (i === state.index ? { ...route, state: fullChild } : route)),
          }
          return
        }
      }
      const next = rootRouter.getStateForAction(state, action as any, OPTIONS)
      if (next !== null) state = rootRouter.getRehydratedState(next, OPTIONS)
    },
    openSettingsSubpage(name: string) {
      const next = rootRouter.getRehydratedState(
        rootRouter.getStateForAction(state, CommonActions.navigate('Settings'), OPTIONS)!,
        OPTIONS,
      )
      const childInit = settingsRouter.getInitialState(SETTINGS_OPTIONS)
      const childNext = settingsRouter.getRehydratedState(
        settingsRouter.getStateForAction(childInit, CommonActions.navigate(name), SETTINGS_OPTIONS)!,
        SETTINGS_OPTIONS,
      )
      state = {
        ...next,
        routes: next.routes.map(route => (route.name === 'Settings' ? { ...route, state: childNext } : route)),
      }
    },
  }
}

test('openChat switches Bots in place from a container-level caller without popTo method', () => {
  const container = createContainer({ kind: 'bot', id: 'b-chief' })
  assert.equal('popTo' in container, false)
  openChat(container, { kind: 'bot', id: 'b-coder' })
  assert.equal(container.getState().routes.length, 1)
  assert.equal(container.getState().routes[0].name, 'Chat')
  assert.deepEqual(container.getState().routes[0].params, { kind: 'bot', id: 'b-coder' })
})

test('openChat pops pushed details screens and nested Settings sheets back to the target chat', () => {
  const container = createContainer({ kind: 'bot', id: 'b-chief' })
  container.dispatch(CommonActions.navigate('BotDetails', { botId: 'b-chief' }))
  container.dispatch(CommonActions.navigate('Memory', { id: 'b-chief', name: 'Chief', group: false }))
  assert.equal(container.getState().routes.length, 3)

  openChat(container, { kind: 'room', id: 'r-team' })
  assert.equal(container.getState().routes.length, 1)
  assert.deepEqual(container.getState().routes[0].params, { kind: 'room', id: 'r-team' })

  container.openSettingsSubpage('Providers')
  assert.equal(container.getState().routes.at(-1)?.name, 'Settings')
  openChat(container, { kind: 'bot', id: 'b-writer' })
  assert.equal(container.getState().routes.length, 1)
  assert.deepEqual(container.getState().routes[0].params, { kind: 'bot', id: 'b-writer' })
})

test('openChat with no target pops back to Chat while preserving existing params', () => {
  const container = createContainer({ kind: 'bot', id: 'b-coder' })
  container.dispatch(CommonActions.navigate('BotDetails', { botId: 'b-coder' }))
  container.dispatch(CommonActions.navigate('BotEdit', { botId: 'b-coder' }))
  openChat(container)
  assert.equal(container.getState().routes.length, 1)
  assert.deepEqual(container.getState().routes[0].params, { kind: 'bot', id: 'b-coder' })
})

test('activeChatTarget resolves launch fallback and clears when another screen is on top', () => {
  const fresh = createContainer()
  assert.deepEqual(activeChatTarget(fresh.getState(), 'b-chief'), { kind: 'bot', id: 'b-chief' })
  assert.equal(activeChatTarget(fresh.getState(), undefined), undefined)

  openChat(fresh, { kind: 'room', id: 'r-1' })
  assert.deepEqual(activeChatTarget(fresh.getState(), 'b-chief'), { kind: 'room', id: 'r-1' })

  fresh.dispatch(CommonActions.navigate('Needs'))
  assert.equal(activeChatTarget(fresh.getState(), 'b-chief'), undefined)
})

// iOS: the team list is the root page and a chat sits on it.
const LIST_OPTIONS = { ...OPTIONS, routeNames: ['Team', ...ROUTE_NAMES] }
function createListContainer() {
  const router = StackRouter({})
  let state = router.getInitialState(LIST_OPTIONS)
  return {
    getState: () => state,
    dispatch(action: NavigationAction) {
      const next = router.getStateForAction(state, action as any, LIST_OPTIONS)
      if (next !== null) state = router.getRehydratedState(next, LIST_OPTIONS)
    },
  }
}

test('openChat from the iOS team list pushes the chat and keeps the list under it', () => {
  const container = createListContainer()
  openChat(container, { kind: 'bot', id: 'b-coder' })
  assert.deepEqual(container.getState().routes.map(route => route.name), ['Team', 'Chat'])
  assert.deepEqual(container.getState().routes[1].params, { kind: 'bot', id: 'b-coder' })
  assert.equal(activeChatTarget(container.getState())?.id, 'b-coder')
})

test('openChat over the iOS list replaces the chat in place and closes a sheet into a chat', () => {
  const container = createListContainer()
  openChat(container, { kind: 'bot', id: 'b-coder' })
  container.dispatch(CommonActions.navigate('BotDetails', { botId: 'b-coder' }))
  openChat(container, { kind: 'room', id: 'r-team' })
  assert.deepEqual(container.getState().routes.map(route => route.name), ['Team', 'Chat'])
  assert.deepEqual(container.getState().routes[1].params, { kind: 'room', id: 'r-team' })

  const fresh = createListContainer()
  fresh.dispatch(CommonActions.navigate('Needs'))
  openChat(fresh, { kind: 'bot', id: 'b-chief' })
  assert.deepEqual(fresh.getState().routes.map(route => route.name), ['Team', 'Chat'])
})

test('the iOS launch state puts the saved chat over the team list', () => {
  const router = StackRouter({})
  const state = router.getRehydratedState(listLaunchState({ kind: 'room', id: 'r-team' }) as any, LIST_OPTIONS)
  assert.deepEqual(state.routes.map(route => route.name), ['Team', 'Chat'])
  assert.equal(activeChatTarget(state)?.id, 'r-team')
  const empty = router.getRehydratedState(listLaunchState(null) as any, LIST_OPTIONS)
  assert.deepEqual(empty.routes.map(route => route.name), ['Team'])
})
