import { Host, Picker, Text } from '@expo/ui/swift-ui'
import { pickerStyle, tag } from '@expo/ui/swift-ui/modifiers'
import type { SegmentedProps } from './segmented-types.ts'

export const NATIVE_SEGMENTED = true

// The system segmented control, sized to its row.
export function NativeSegmented({ options, value, onPick, dark }: SegmentedProps) {
  return (
    <Host matchContents={{ vertical: true }} colorScheme={dark ? 'dark' : 'light'} style={{ alignSelf: 'stretch' }}>
      <Picker selection={value} onSelectionChange={next => onPick(String(next))} modifiers={[pickerStyle('segmented')]}>
        {options.map(option => <Text key={option.id} modifiers={[tag(option.id)]}>{option.label}</Text>)}
      </Picker>
    </Host>
  )
}
