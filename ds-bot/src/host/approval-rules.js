// "Always allow" rules for approvals (docs/plans/2026-11-18-approval-rules.md). A rule
// is the user's, kept on one Bot, and covers either one folder for the file tools or
// one exact command for the shell tools. Nothing here reads the disk: the caller turns
// the paths into real ones first.
import { randomUUID } from 'node:crypto'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { within } from './folders.js'

const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_editor'])
const SHELL_TOOLS = new Set(['bash', 'pwsh'])
const PATCH_PATH = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/gm

export const RULES_MAX = 50
export const TIMEOUT_DEFAULT_MIN = 10
export const TIMEOUT_CHOICES = [0, 5, 10, 30, 60]

/** The minutes an approval may wait before it is rejected, 0 for never. */
export function timeoutMinutes(prefs) {
  const value = prefs?.approvalTimeout
  return TIMEOUT_CHOICES.includes(value) ? value : TIMEOUT_DEFAULT_MIN
}

/** Every path an `apply_patch` input touches, as written. */
export function patchPaths(input) {
  return [...String(input ?? '').matchAll(PATCH_PATH)].map(match => match[1].trim()).filter(Boolean)
}

/**
 * What one approval asks about, from the tool call's arguments: the paths of a file
 * tool, resolved against the Session's folder, or a shell tool's command. Undefined
 * when it is neither, or a relative path has no folder to resolve against.
 * @param {string} tool
 * @param {Record<string, unknown>} args
 * @param {string | undefined} folder the Session's working folder
 * @returns {{ kind: 'paths', paths: string[] } | { kind: 'command', tool: string, command: string } | undefined}
 */
export function askOf(tool, args, folder) {
  if (SHELL_TOOLS.has(tool)) {
    const command = [args?.command, args?.cmd].find(value => typeof value === 'string' && value.trim() !== '')
    return command === undefined ? undefined : { kind: 'command', tool, command }
  }
  let written
  if (tool === 'apply_patch') written = patchPaths(args?.input)
  else if (FILE_TOOLS.has(tool)) written = [args?.file_path, args?.path].filter(value => typeof value === 'string' && value.trim() !== '').slice(0, 1)
  if (!written?.length) return undefined
  const paths = []
  for (const path of written) {
    if (isAbsolute(path)) paths.push(resolve(path))
    else if (folder) paths.push(resolve(folder, path))
    else return undefined
  }
  return { kind: 'paths', paths }
}

/** The deepest folder that holds every path. */
export function commonFolder(paths) {
  let folder = dirname(paths[0])
  while (!paths.every(path => within(path, folder))) {
    const up = dirname(folder)
    if (up === folder) return folder
    folder = up
  }
  return folder
}

/** The rule "Always allow" would save for this ask, as the card shows it. */
export function offerOf(ask) {
  if (ask === undefined) return undefined
  if (ask.kind === 'command') return { kind: 'command', tool: ask.tool, command: ask.command }
  const folder = commonFolder(ask.paths)
  // The root of a disk is not a folder rule, it is full access.
  if (dirname(folder) === folder || folder.split(sep).filter(Boolean).length < 2) return undefined
  return { kind: 'folder', folder }
}

/** Whether a saved rule covers this ask. Paths must already be real. */
export function ruleCovers(rule, ask) {
  if (ask === undefined || rule === undefined) return false
  if (rule.kind === 'command') return ask.kind === 'command' && rule.tool === ask.tool && rule.command === ask.command
  if (rule.kind === 'folder') return ask.kind === 'paths' && ask.paths.every(path => within(path, rule.folder))
  return false
}

/** A new rule for a Bot from an offer, newest last; an equal rule is kept, not doubled. */
export function addRule(rules, offer, at = Date.now()) {
  const list = Array.isArray(rules) ? rules : []
  const same = list.find(rule => rule.kind === offer.kind && (offer.kind === 'folder' ? rule.folder === offer.folder : rule.tool === offer.tool && rule.command === offer.command))
  if (same) return list
  const rule = offer.kind === 'folder'
    ? { id: randomUUID(), kind: 'folder', folder: offer.folder, at }
    : { id: randomUUID(), kind: 'command', tool: offer.tool, command: offer.command, at }
  return [...list, rule].slice(-RULES_MAX)
}
