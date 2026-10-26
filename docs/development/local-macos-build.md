# Building and updating this fork on macOS

This guide is for the in-app Dev Bot and local contributors. Read `AGENTS.md` first. Work in the repository checkout, on the user's current fork branch. The installed app is the deployment target, not the source tree. Do not patch DSH, hand-edit generated `client.js`, or edit `app.asar` to implement a change.

## 1. Establish the source and scope

- Inspect `git status`, the branch, remotes, and the diff. Keep unrelated user changes. For this fork, pushes go to `BangyiZhang/DeepSeek-Bot`, never upstream.
- If a local change exists only in the installed app, identify the changed **DS Bot-owned** files and port it back to source before rebuilding. Rebuild `client.js` from `ds-bot/src/client/`. Verify the rebuilt code matches the intended local change.
- Use native arm64 Node 24+ and npm for the Apple silicon build. This workspace may have an ignored `work/npm24` wrapper; use it when present. It is a local convenience, not a dependency of the repository.
- Do not reset dependencies unnecessarily. The app installs `ds-bot` as a **copy**. `npm install` can retain that copy when the version is unchanged.

## 2. Build and refresh the app's plugin copy

From the repository root:

```sh
npm --prefix ds-bot run build
node ds-bot/scripts/build-client.mjs --check
cp ds-bot/client.js app/node_modules/ds-bot/client.js
```

When host or shared plugin code changed, copy the corresponding package files too:

```sh
cp ds-bot/index.js ds-bot/web-search.js ds-bot/cordis.patch.yml app/node_modules/ds-bot/
ditto ds-bot/src/host app/node_modules/ds-bot/src/host
ditto ds-bot/src/shared app/node_modules/ds-bot/src/shared
```

For dependency changes or a clean checkout, follow `app/README.md` and the lockfiles instead. Do not copy test homes, credentials, arbitrary installed plugins, or user data into the package.

The current machine's speech loader also has an existing local dependency adjustment. It is not a tracked, reproducible build step. Preserve and verify existing local dependencies during an incremental build; do not claim a clean install reproduces that adjustment. If a clean install exposes a loader problem, diagnose supported packaging or upstream dependency behavior instead of patching DSH or quietly changing a vendor package. Local TTS endpoints, services and model caches are configuration outside the source package; a ZIP does not install them on another machine.

## 3. Validate the change

```sh
npm --prefix ds-bot test
npm --prefix ds-bot run lint
node ds-bot/scripts/build-client.mjs --check
TMPDIR=/private/tmp npm --prefix app test
git diff --check
```

`TMPDIR=/private/tmp` avoids the `/var` versus `/private/var` alias in macOS temporary-path assertions. It does not change application data. Record failed checks and skipped tests honestly. For `index.js` or host changes, also run the repository's mock smoke test and stop its processes afterward.

Never point a test at the user's DSH home, desktop data, active team, or real model credentials. Use the mock model and isolated test folders.

For interface changes, inspect the **computed appearance**, not only React state or `aria-current`. Both plugin CSS and `app/src/mac-frame.css` apply in the installed Mac app. A more specific frame rule can erase an otherwise correct selection. Verify light and dark modes, hover and rest, relevant collapsed layouts, and the user's actual scenario. For the Chief tile, an active marker without its visible background and accent outline is a failure.

## 4. Package and test the packaged app

```sh
npm --prefix app run build
npm --prefix app run pack -- --mac --arm64
codesign --verify --deep --strict 'app/dist-pack/mac-arm64/DeepSeek Bot.app'
npm --prefix app run check-packed
```

The check launches a **copy** of the built app outside the checkout, uses temporary home/shell/workspace folders and a loopback mock, disables local CLI providers and update checks, exercises chat and the visible Chief highlight, and closes the app. The installed user's app must never be passed as the test executable. This catches missing packaged files and frame CSS that source tests cannot see.

Compare the packaged DS Bot files with the built source. A build log alone does not prove the app contains the latest plugin copy.

Create a uniquely named ZIP after those checks, for example:

```sh
ditto -c -k --sequesterRsrc --keepParent \
  'app/dist-pack/mac-arm64/DeepSeek Bot.app' \
  'app/dist-pack/DeepSeek-Bot-0.2.1-mac-arm64-local-build.zip'
```

Wait for the ZIP writer to exit, then validate the archive, for example with Python's `ZipFile.testzip()`. Retain the previous installer until the new archive and installation are verified. The user's preference is to keep only the latest verified installer afterward.

## 5. Install without interrupting the build itself

A Bot runs inside the application it is updating. Quitting that app also stops its Host and can interrupt the Bot's turn or Pi Durable work. Do not replace the running app in place and do not declare success before restart verification.

1. Finish building, testing, signing and archiving first. Save the exact artifact path, checks, hashes and intended installation steps in the task's results and a local handoff record before shutdown.
2. Confirm the user's chats and other Bots are idle. Stage the complete verified app separately in Applications and keep a recoverable copy of the existing app until validation succeeds.
3. Use an independent, vetted installer/controller outside the app's Host to coordinate graceful quit, replacement and launch. Do not assume a managed shell job or Pi task will survive quitting its own Host. If no such controller is available, give the user the verified artifact and the concrete remaining installation/restart step; do not claim an unattended installation occurred.
4. Verify the installed signature and content hash, launch normally, and confirm the existing team/chat and changed UI load. A listening port or HTTP 401 proves only that the Host is responding, not that the UI fix works. Do not send mock tasks to the user's real team.
5. On failure, restore the previous app. Do not delete or overwrite the user's data, profile, credentials, model caches or local service settings. Once verified, remove only superseded build artifacts and redundant app copies.

An uncertain task result is not permission to rerun side effects. Inspect the known build logs, owned process IDs, artifact timestamps/hashes and saved progress first. If the earlier command cannot be safely reconciled, report that limitation.

## 6. Report and publish accurately

Report source revision or local changes, test results, exact ZIP path, and whether installation and restart verification actually happened. Keep these states separate: source saved, client built, app packaged, archive validated, installed, restarted, and visually verified.

Commit/push only when requested, using the human user's identity and the user's fork. A local package is not a GitHub Release. Do not bump versions, create tags, publish releases, change security settings or expand permissions merely to build or install locally.
