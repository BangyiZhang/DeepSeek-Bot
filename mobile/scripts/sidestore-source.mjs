// Adds a built IPA to the SideStore / AltStore source in sidestore/source.json, newest first.
//
//   node scripts/sidestore-source.mjs <path/to/DSBot.ipa> <download URL> [what changed]
//
// The source declares the app's privacy keys, read from the IPA's Info.plist: SideStore
// refuses an install whose permissions differ from what its source says.
import { execFileSync } from 'node:child_process'
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const [ipa, downloadURL, notes = ''] = process.argv.slice(2)
if (!ipa || !/^https:\/\//.test(downloadURL ?? '')) {
  console.error('usage: node scripts/sidestore-source.mjs <ipa> <https download URL> [notes]')
  process.exit(2)
}

const here = dirname(dirname(fileURLToPath(import.meta.url)))
const out = join(here, 'sidestore', 'source.json')
const plist = JSON.parse(execFileSync('/bin/sh', ['-c', 'unzip -p "$1" "Payload/*.app/Info.plist" | plutil -convert json -o - -', 'sh', ipa], { encoding: 'utf8' }))

const privacy = Object.fromEntries(Object.entries(plist).filter(([key]) => /UsageDescription$/.test(key)))
const version = {
  version: plist.CFBundleShortVersionString,
  buildVersion: plist.CFBundleVersion,
  date: new Date().toISOString(),
  localizedDescription: notes,
  downloadURL,
  size: statSync(ipa).size,
  minOSVersion: plist.MinimumOSVersion,
}

let source
try { source = JSON.parse(readFileSync(out, 'utf8')) } catch { source = null }
const raw = 'https://raw.githubusercontent.com/BangyiZhang/DeepSeek-Bot/main/mobile'
source ??= {
  name: 'DS Bot',
  identifier: 'io.github.bangyizhang.dsbot.source',
  sourceURL: `${raw}/sidestore/source.json`,
  iconURL: `${raw}/assets/icon.png`,
  apps: [{
    name: 'DS Bot',
    bundleIdentifier: plist.CFBundleIdentifier,
    developerName: 'DS Bot',
    subtitle: 'Your Bot team, from your phone',
    localizedDescription: 'Controls the DS Bot team that runs on your computer, through an end-to-end encrypted link. Pair it in DS Bot under Settings → Phone.',
    iconURL: `${raw}/assets/icon.png`,
    tintColor: '#4d6bfe',
    versions: [],
    appPermissions: { entitlements: [], privacy: {} },
  }],
  news: [],
}
const app = source.apps[0]
app.appPermissions.privacy = privacy
app.versions = [version, ...app.versions.filter(entry => entry.version !== version.version || entry.buildVersion !== version.buildVersion)]
writeFileSync(out, `${JSON.stringify(source, null, 2)}\n`)
console.log(`sidestore-source: ${version.version} (${version.buildVersion}) → ${out}`)
