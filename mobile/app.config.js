// The phone app ships with DS Bot and carries its version. Android installs an update
// only over a lower versionCode, so the code grows with the version, and a pre-release
// (0.4.0-rc.1) stays below its release (0.4.0).
const { version } = require('../ds-bot/package.json')

function versionCode(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-[a-z]+\.(\d+))?$/.exec(text)
  if (match === null) throw new Error(`app.config: cannot make an Android versionCode from ${text}`)
  const [, major, minor, patch, pre] = match.map(Number)
  if (minor > 999 || patch > 999 || pre > 98) throw new Error(`app.config: ${text} is out of the versionCode range`)
  return ((major * 1000 + minor) * 1000 + patch) * 100 + (match[4] === undefined ? 99 : pre)
}

// SideStore offers an update only for a higher major.minor.patch, not a higher build
// number, so an iPhone-only change between DS Bot releases raises ios.version in
// app.json. The iPhone takes whichever of the two is higher, so it never goes back when
// DS Bot catches up.
function semver(text) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(text ?? '')
  return match === null ? null : match.slice(1).map(Number)
}
function iosVersion(dsBot, own) {
  const a = semver(dsBot), b = semver(own)
  if (b === null) return dsBot
  if (a === null) return own
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? dsBot : own
  return dsBot
}

// The Apple Developer team signs the archive; it is account data, so it comes from the
// environment and is never written here (docs/plans/2026-11-13-ios-release.md).
const appleTeamId = (process.env.DS_BOT_APPLE_TEAM_ID ?? '').trim()
// A build signed with someone's own Apple ID needs a bundle id that their team owns;
// io.github.fei2411.dsbot belongs to the release account.
const bundleIdentifier = (process.env.DS_BOT_IOS_BUNDLE_ID ?? '').trim()

module.exports = ({ config }) => {
  const ios = iosVersion(version, config.ios?.version)
  return {
    ...config,
    version,
    android: { ...config.android, versionCode: versionCode(version) },
    ios: {
      ...config.ios,
      version: ios,
      buildNumber: (process.env.DS_BOT_IOS_BUILD_NUMBER ?? ios).trim(),
      ...(appleTeamId === '' ? {} : { appleTeamId }),
      ...(bundleIdentifier === '' ? {} : { bundleIdentifier }),
    },
  }
}
module.exports.versionCode = versionCode
module.exports.iosVersion = iosVersion
