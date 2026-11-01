# Upstream synchronization, 2026-11-01

The local integration branch merges upstream `dev` at `415020eda4469d64ed3fbb9d83fcd566c2c4552f` into the personal fork based on `38621dd7c02036bcd7c34bf2844c914a1f457f2b`. This is a source synchronization; the fork version remains 0.2.6. It does not build an installer, change the installed application, publish a release or push a remote branch.

All upstream changes are included, including private Bots, Office tools, learning proposals, per-session tool registration, delivery and recall fixes, frame resizing, the desktop tray and mobile source. The fork retains its UI, local Agent CLI adapters, speech playback, local update controller and Pi Durable runtime.

## Integration decisions

- Upstream team tools now register inside Bot scopes. Durable controls and desktop update controls join that registry; ordinary DSH Agents receive neither. Dedicated task workers restore only their captured Bot read/context and HITL tools inside their own scope. They retain the existing captured-tool guard and cannot manage the team, create nested durable tasks or install the application.
- Private Bot ownership follows durable workers and their descendants. Other Bots cannot read private task sessions or the shared Pi database.
- Durable startup waits until module installation finishes, so upstream state migration can use the group-log helpers before loading saved state.
- The resizable sidebar retains the fork's flat surfaces, visible light-theme borders, Chief selection, avatar/header chevron behavior and Connect plugins entry. Its button folds to the avatar rail; dragging still resizes it. The Mac rail remains 96px, with controls below the native traffic lights. The native frame relinquishes its left track while the Bot column is present, and restores it in Agent mode.
- Existing local Mac window lifecycle changes are retained and adapted to the upstream tray: ordinary close minimizes the same window; Dock activation restores it; application Quit and Command+Q stop the Host. Shutdown and updater exits bypass minimizing. Other platforms retain upstream tray behavior.
- Both lockfiles include the fork dependencies. DSH stays on the upstream public 0.2.1-rc.4 packages; its Pi model adapter retains its compatible Pi AI dependency. No DSH package is patched.

## Validation

The plugin unit suite, desktop unit suite, lint and generated client/Office checks pass. The isolated real Host smoke passes all 52 checks. The real Pi/DSH chat integration passes creation, inherited context/capabilities, scoped tools, task ownership, clean and forced restart recovery, cancellation, pause/continue, card and chat HITL answers, background job notices and owned subagent relays. Tests use disposable profiles and the mock model.

Browser checks use an isolated source Host rather than the installed application. They cover sidebar geometry, light/dark surfaces, attachment placement and header behavior. Native traffic lights themselves are reserved by the layout; browser previews do not render native window chrome. Installer and Office runtime payload packaging are intentionally not exercised in this source-only synchronization.
