import { useLayoutEffect, useRef, type ReactNode } from 'react'
import { Platform } from 'react-native'
import { useNavigation } from '@react-navigation/native'
import type { NativeStackHeaderItem, NativeStackNavigationOptions } from '@react-navigation/native-stack'
import type { SFSymbol } from 'sf-symbols-typescript'
import { useTheme } from '../ui/tokens.ts'

// On iOS every page takes the system navigation bar (docs/plans/2026-11-17-ios-native-ui.md):
// the pages keep their own header components, which there set the bar's title and
// buttons and draw nothing. Android keeps the drawn headers.
export const NATIVE_HEADER = Platform.OS === 'ios'

export interface BarButton {
  label: string
  onPress: () => void
  icon?: SFSymbol
  disabled?: boolean
  // The form's finishing action (Done, Create).
  strong?: boolean
  badge?: number
}

// Handlers are read through a ref, so a new closure on every render reaches the bar
// without setting the options again.
function useBarItems(buttons: (BarButton | undefined)[], tint: string) {
  const latest = useRef(buttons)
  latest.current = buttons
  const items = (): NativeStackHeaderItem[] => latest.current.flatMap((button, index) => button === undefined ? [] : [{
    type: 'button' as const,
    label: button.label,
    accessibilityLabel: button.label,
    onPress: () => latest.current[index]?.onPress(),
    disabled: button.disabled === true,
    variant: button.strong === true ? 'done' as const : 'plain' as const,
    tintColor: tint,
    ...(button.icon !== undefined ? { icon: { type: 'sfSymbol' as const, name: button.icon } } : {}),
    ...(button.badge !== undefined && button.badge > 0 ? { badge: { value: button.badge } } : {}),
  }])
  const key = tint + buttons.map(button => button === undefined ? '-' : `${button.label}:${button.icon ?? ''}:${button.disabled === true}:${button.strong === true}:${button.badge ?? 0}`).join('|')
  return { items, key }
}

// Sets the iOS bar of the page this is rendered in; does nothing elsewhere.
export function useNativeBar({ title, left, right, titleView, extra }: {
  title?: string
  left?: (BarButton | undefined)[]
  right?: (BarButton | undefined)[]
  titleView?: () => ReactNode
  extra?: NativeStackNavigationOptions
}) {
  const navigation = useNavigation()
  const { p } = useTheme()
  const leftItems = useBarItems(left ?? [], p.accent)
  const rightItems = useBarItems(right ?? [], p.accent)
  const titleRef = useRef(titleView)
  titleRef.current = titleView
  const hasTitleView = titleView !== undefined
  useLayoutEffect(() => {
    if (!NATIVE_HEADER) return
    navigation.setOptions({
      headerShown: true,
      title: title ?? '',
      ...(left !== undefined ? { unstable_headerLeftItems: leftItems.items } : {}),
      ...(right !== undefined ? { unstable_headerRightItems: rightItems.items } : {}),
      ...(hasTitleView ? { headerTitle: () => titleRef.current?.() } : {}),
      ...extra,
    })
  }, [navigation, title, leftItems.key, rightItems.key, hasTitleView, left !== undefined, right !== undefined])
}

// A page header for iOS as a component, for pages that draw their header in JSX.
export function NativeBar(props: Parameters<typeof useNativeBar>[0]) {
  useNativeBar(props)
  return null
}
