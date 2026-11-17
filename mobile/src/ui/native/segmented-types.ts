export interface SegmentedProps {
  options: { id: string; label: string }[]
  value: string
  onPick: (id: string) => void
  dark: boolean
  accessibilityLabel?: string
}
