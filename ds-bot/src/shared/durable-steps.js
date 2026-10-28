export function taskStepTitle(prompt) {
  if (typeof prompt !== 'string') return ''
  const first = prompt.split(/\r?\n/u).find(line => line.trim())?.trim() ?? ''
  const title = first.replace(/^(?:#{1,6}\s+|[-*]\s+|\d+[.)、]\s*)/u, '').replace(/\s+/gu, ' ')
  const characters = [...title]
  return characters.length > 160 ? `${characters.slice(0, 159).join('')}…` : title
}
