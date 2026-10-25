# Contributing

Ambient Suggestions is a small DSH web client extension with local keyword rules. Contributions should preserve predictable behavior and document any assumptions about host APIs.

## Development

1. Install dependencies with `npm install`.
2. Make the smallest change that addresses the issue.
3. Run `npm run build` and `npm test`.
4. Run `npm pack --dry-run` when changing exports, build output, package metadata, or bundle loading.
5. For UI or integration changes, test in the actual target DSH web host and record the host version and installation method.

Keep documentation, code comments, and user-facing copy in English. Avoid introducing claims about performance, publication, privacy, or compatibility without evidence. Local keyword selection makes no suggestion-generation model calls; sending a selected prompt still uses normal host services.

## Integration review

The bundle patch mounts the package root as a host plugin. The root exports a named no-op `apply`, and DSH loads the web client through the `./client` export and `ModuleLoader` registration. Preserve that distinction when changing packaging.

For changes that affect the dock, verify:

- Suggestions appear after a completed assistant response and stay hidden while the assistant is running.
- `maxChips` works for values from one to three.
- `hideOnTyping` hides suggestions when enabled and the composer contains text.
- Selecting a suggestion sends its full prompt once and dismisses the current suggestions.
- Conversation switching does not show stale suggestions or send to the wrong conversation.
- Buttons remain usable with keyboard navigation, narrow windows, and light and dark host themes.

Automated tests and a browser bundle build do not prove these host behaviors. Clearly state any checks you could not run.

## Reporting issues

Include the DSH or DeepSeek Bot version, operating system, installation method, relevant configuration, reproduction steps, expected behavior, and observed behavior. Share logs or screenshots only after removing secrets and private conversation content. Do not assume the repository's example URLs identify a published project or support channel.

## Release changes

Follow [the marketplace guide](marketplace/README.md) when editing the catalog. Keep the staging index empty until an installable release and its metadata have been verified. Validate changes with the installed Format 1 parser; do not substitute guessed field names.

Before proposing publication, review the package contents, generated browser entry, exports, bundle patch, license, documentation, and supported DSH range. Record exact build and test results plus any remaining integration limitations. Publication and external announcements require separate maintainer authorization.

## License

By contributing, you agree that your contribution is distributed under the project's [MIT license](LICENSE).
