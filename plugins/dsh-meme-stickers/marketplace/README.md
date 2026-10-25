# Format 1 staging index

`market-index.json` is a valid Format 1 index with an intentionally empty `plugins` array. This package has not been published. No installable release is advertised.

The actual installed `@deepseek-ai/dsh-plugin-market-index` parser was inspected and used for validation. A release entry requires `name`, a nonempty `versions` array, exact `version`, integer Unix-seconds `publishTimestamp`, and `source`. The npm source is `{ "type": "npm" }` with an optional `registry`; the parser derives `name@version`. A Git source requires `{ "type": "git", "url": "https://…", "commit": "<40 lowercase hexadecimal characters>" }` and may have a relative package `path`. A branch name, fake commit, local tarball path, or fabricated timestamp is not an honest release entry.

Before adding a plugin entry, establish actual package ownership, a public repository or npm release, the publication time, asset permissions, and supported DSH versions. Validate the completed index with the host parser and test installation in a disposable profile. Do not add an engine range without evidence or imply that schema validation proves runtime installation.

This index can be served from a real source URL after release preparation. No hosted source URL is claimed here. Public distribution of the combined asset bundle is subject to the unresolved permissions in `../THIRD_PARTY_ASSETS.md`.
