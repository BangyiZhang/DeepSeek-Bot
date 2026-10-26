# Building and updating this fork on macOS

This guide is for the in-app Dev Bot and local contributors. Read `AGENTS.md` first. Work in the repository checkout, on the user's current fork branch. The installed app is the deployment target, not the source tree. Do not patch DSH, hand-edit generated `client.js`, or edit `app.asar` to implement a change.

## 1. Establish the source and scope

- Inspect `git status`, the branch, remotes, and the diff. Keep unrelated user changes. For this fork, pushes go to `BangyiZhang/DeepSeek-Bot`, never upstream.
- If a local change exists only in the installed app, identify the changed **DS Bot-owned** files and port it back to source before rebuilding. Rebuild `client.js` from `ds-bot/src/client/`. Verify the rebuilt code matches the intended local change.
- Use native arm64 Node 24+ and npm for the Apple silicon build. This workspace may have an ignored `work/npm24` wrapper; use it when present. It is a local convenience, not a dependency of the repository.
- Do not reset dependencies unnecessarily. The app installs `ds-bot` as a **copy**. `npm install` can retain that copy when the version is unchanged.

## 2. Use the preparation command

For an incremental macOS build, run this from the checkout root with native Node 24+:

```sh
npm --prefix app run local-update:prepare
# In this workspace, the optional Node 24 wrapper can be used instead:
./work/npm24 --prefix app run local-update:prepare
```

The command builds the client, refreshes the app's copied `ds-bot` package, runs plugin tests/lint/client checks, app tests and an isolated mock Host smoke test, builds and packages the app, verifies its bundle identity/signature/architecture, runs the packaged chat/UI check and validates a new ZIP. It does not install or publish. It stops at the first failed check; inspect the named log instead of assuming later stages ran. Expect the full smoke test to take several minutes. Do not edit production sources during preparation: source fingerprints and a file-by-file ASAR comparison reject a changing or stale build.

On success the last line is JSON with `appPath`, `zipPath`, `evidencePath` and `appHash`. Save those exact paths and read the report. The report binds the passed checks to that exact candidate ASAR. Logs and reports stay under ignored `work/local-updates/<build-id>/` with private permissions. Do not invent a report or mark a failed check passed. The controller rechecks the current bundle before staging and replacement.

For a dependency change or clean checkout, follow `app/README.md` and the lockfiles first. Do not copy credentials or user profiles into the package. Do not reset dependencies unnecessarily. This machine has an existing local speech-loader dependency adjustment that is not a tracked, reproducible build step. Preserve it during incremental builds; do not claim a clean dependency install reproduces it. If a clean build exposes a loader problem, diagnose supported packaging/upstream behavior rather than patch DSH or silently modify a vendor package. Local TTS services and caches are separate configuration.

## 3. Check the user's actual change

The automated packaged check verifies chat and the Chief selection. It cannot prove every new feature or visual change. Add meaningful focused verification for the change. For interface work check computed appearance, light/dark themes, hover/rest and relevant collapsed layouts; both plugin CSS and `app/src/mac-frame.css` apply. An active marker without its visible highlight is a failure.

Tests must use throwaway data and mock models. Never test against the installed user's profile, `~/.dsh`, active team or real credentials. A listening port or HTTP 401 alone does not verify the UI.

## 4. Hand installation to the desktop controller

A Bot's Host and its managed shell jobs stop when the application quits. Complete the build and its checks first. **Keep a self-update task in the originating Bot's user-requested private chat**, because the installer tool is unavailable in Pi Durable workers, DSH Agent sessions and groups. Do not delegate the installer to a new task or call it from an automated receipt.

1. Read the successful preparation report and record the tested change and artifact paths in the chat.
2. Call `request_desktop_update` with the exact `appPath` and `evidencePath`. The destination is fixed to the running app; a tool cannot choose another app to overwrite.
3. If accepted, say the update is **queued**, then **end the turn**. Do not sleep, wait for restart, poll, or keep a shell job alive. The desktop waits for active agents, inboxes, jobs, group rounds and unfinished durable tasks to become idle. A task that has actually saved its paused checkpoint does not block it. If other work keeps running, the update stays queued.
4. The desktop stages and validates the candidate, snapshots its own runtime, starts a detached installer, arms the handoff and quits normally. The installer waits for the original PID to exit, keeps the old app, swaps the staged app into place and launches it. It never force-quits the old app or changes the team's data.
5. Only a matching launched PID/ASAR receipt after **Host and chat UI readiness** yields `completed`. Startup failure stops only the owned replacement and restores/restarts the verified old app; `rolled_back` also requires old-app health. The origin Bot receives one saved result after restart. Report that result in the user's language and do not rerun installation from it.
6. Use `get_desktop_update` when the user asks about status, or to reconcile an uncertain outcome. `failed` means no verified installation; `recovery_failed` needs inspection and preserves recoverable bundles. `report: attempted` means callback delivery is uncertain and must not be blindly repeated. The installation receipt remains readable.

For changes to the controller itself, also run the real restart acceptance on the prepared report:

```sh
node app/scripts/check-local-update.mjs /absolute/path/to/report.json
```

It copies the candidate into a throwaway `.dsh-test-local-update-*` folder, starts a loopback mock, calls the real tool through chat, checks that the original PID exits and a replacement Host/UI acknowledges the exact hash, then confirms the Bot report is saved. The installed app and real team are not test targets. Failure/rollback and lock behavior are covered by isolated installer tests.

This controller is available only in the packaged macOS application. The first version containing it must be installed externally once. It installs no launch daemon, asks for no administrator privileges and cannot update a destination the current user cannot write. The regular GitHub download updater remains separate.

## 5. Recovery and artifact cleanup

Job records are in `<Electron userData>/local-updates/<job-id>/job.json`. Each job records its target, stage, backup, previous/new hashes and owned process IDs, without provider credentials or environment dumps. The independent installer files and `Runner.app` live beside that record. Nonterminal interrupted jobs can be reconciled by running their own saved worker with a supported Node runtime:

```sh
node /absolute/job-folder/worker.mjs /absolute/job-folder/job.json
```

Check the recorded PIDs and phase first. An active worker owns a lock and a second worker refuses to run. Recovery never kills an unowned process or overwrites an unknown target. If `recovery_failed` is terminal, inspect the journal and verify the retained bundles before any manual restoration; do not clear its state, delete the backup, or retry side effects blindly. A timeout can mean the previous bundle was restored but its health could not be confirmed.

The successful install removes its old backup; the restarted desktop removes the runner snapshot only after its worker exits. A failed recovery retains its snapshot and backups. Once the installed app and the user's change are verified, keep the latest verified ZIP and remove only superseded build artifacts/redundant app copies. Do not delete user data, profiles, caches, dependencies, logs needed for reconciliation, or unknown files to save disk space.

## 6. Report and publish accurately

Report source revision/local changes, checks, exact ZIP path and the saved installation outcome. Keep source saved, packaged, archive validated, installed, restarted and visually verified distinct. A health receipt confirms the Host/chat UI, not every new UI detail.

Commit/push only when requested, using the human user's identity and the user's fork. Local updates do not authorize version bumps, tags, GitHub Releases, permission changes or publication.
