import { StackActions, type NavigationAction, type NavigationState, type PartialState } from '@react-navigation/core'
import type { ChatTarget } from '../screens/TeamList.tsx'

// Components outside Stack.Navigator (the drawer and the notice banner) receive the
// NavigationContainer ref, which exposes CommonActions and dispatch but not stack
// helpers like popTo. Dispatching StackActions.popTo works from both the container
// and any screen or modal sheet inside the stack.
//
// On iOS the team list is the root page under the chat (ShellB). popTo with no Chat in
// the stack replaces the top page, which there would drop the list, so a chat opened
// from the list is pushed on it.
export function openChat(navigation: { dispatch: (action: NavigationAction) => void; getState?: () => StateLike }, target?: ChatTarget) {
  const state = navigation.getState?.()
  const top = state?.routes?.[state.index ?? 0]
  if (top?.name === 'Team' && target !== undefined) {
    navigation.dispatch(StackActions.push('Chat', target))
    return
  }
  navigation.dispatch(StackActions.popTo('Chat', target, target === undefined ? { merge: true } : undefined))
}

type StateLike = NavigationState | PartialState<NavigationState> | undefined

// iOS launch: the team list, and the chat the app was last on pushed over it.
export function listLaunchState(saved: ChatTarget | null): PartialState<NavigationState> {
  const routes = saved === null ? [{ name: 'Team' }] : [{ name: 'Team' }, { name: 'Chat', params: { kind: saved.kind, id: saved.id } }]
  return { index: routes.length - 1, routes }
}

// Which chat is currently visible on top of the root stack, accounting for the
// launch state before explicit route params are set (where Chat falls back to the
// first Main Bot).
export function activeChatTarget(state: StateLike, fallbackBotId?: string): ChatTarget | undefined {
  const index = state?.index ?? 0
  const top = state?.routes?.[index]
  if (top?.name !== 'Chat') return undefined
  const params = top.params as Partial<ChatTarget> | undefined
  if ((params?.kind === 'bot' || params?.kind === 'room') && typeof params.id === 'string' && params.id !== '') {
    return { kind: params.kind, id: params.id }
  }
  return fallbackBotId ? { kind: 'bot', id: fallbackBotId } : undefined
}
