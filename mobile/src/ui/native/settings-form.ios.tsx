import { Button, Form, HStack, Host, Image, Picker, Section, Spacer, Text, Toggle } from '@expo/ui/swift-ui'
import { foregroundStyle, pickerStyle, tag, tint } from '@expo/ui/swift-ui/modifiers'
import type { SettingsFormProps, SettingsLink } from './settings-form-types.ts'

export const SETTINGS_FORM = true

// The phone's Settings page as the system's own grouped form (docs/plans/2026-11-17-ios-native-ui.md).
export function SettingsForm(props: SettingsFormProps) {
  const link = (entry: SettingsLink) => (
    <Button key={entry.id} onPress={() => props.onOpen(entry.id)}>
      <HStack spacing={8}>
        <Text modifiers={[foregroundStyle(props.ink)]}>{entry.label}</Text>
        <Spacer />
        {entry.value !== undefined && entry.value !== '' ? <Text modifiers={[foregroundStyle(props.ink2)]}>{entry.value}</Text> : null}
        <Image systemName="chevron.forward" size={13} color="#8e8e93" />
      </HStack>
    </Button>
  )
  return (
    <Host style={{ flex: 1 }} colorScheme={props.dark ? 'dark' : 'light'}>
      <Form modifiers={[tint(props.accent)]}>
        <Section title={props.labels.phone}>
          {props.phone.map(link)}
          <Picker label={props.labels.appearance} selection={props.theme} onSelectionChange={value => props.onTheme(String(value))} modifiers={[pickerStyle('menu')]}>
            {props.themes.map(option => <Text key={option.id} modifiers={[tag(option.id)]}>{option.label}</Text>)}
          </Picker>
          <Picker label={props.labels.language} selection={props.lang} onSelectionChange={value => props.onLang(String(value))} modifiers={[pickerStyle('menu')]}>
            {props.langs.map(option => <Text key={option.id} modifiers={[tag(option.id)]}>{option.label}</Text>)}
          </Picker>
          <Toggle label={props.labels.banners} isOn={props.banners} onIsOnChange={props.onBanners} />
        </Section>
        <Section title={props.labels.team}>
          {props.team.map(link)}
        </Section>
      </Form>
    </Host>
  )
}
