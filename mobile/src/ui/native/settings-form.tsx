import type { SettingsFormProps } from './settings-form-types.ts'

// Only iOS draws the settings as a SwiftUI form (settings-form.ios.tsx).
export const SETTINGS_FORM = false
export function SettingsForm(_props: SettingsFormProps): null {
  return null
}
