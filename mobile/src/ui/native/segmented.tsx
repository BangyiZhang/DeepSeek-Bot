import type { SegmentedProps } from './segmented-types.ts'

// Only iOS draws a system segmented control (segmented.ios.tsx).
export const NATIVE_SEGMENTED = false
export function NativeSegmented(_props: SegmentedProps): null {
  return null
}
