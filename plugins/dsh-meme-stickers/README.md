# DSH Meme Stickers

A DeepSeek Harness web plugin that displays local meme images at a maximum of **140 × 140 CSS pixels**, with `object-fit: contain`, an 8-pixel corner radius, and inline-block display. Small images keep their natural size. Ordinary photos retain the host's normal presentation. The host still owns image loading, failure messages, accessibility, and full-size previews.

Sticker-only `.bt-bubble` messages also lose their background, border, shadow, and padding. The classifier allows only whitespace and structural wrappers around recognized stickers; messages containing text, screenshots, other images, controls, or other content keep their normal bubbles. Streamed text and reused image nodes are rechecked, and disposal restores the host presentation.

The source package contains renderer and provisioning software. Image libraries are supplied separately by the user. The software is MIT licensed; external images require their own permissions. Read [THIRD_PARTY_ASSETS.md](THIRD_PARTY_ASSETS.md) before distributing the combined bundle.

## Build and local installation

Requires Node.js 20 or later and a DSH web host using the inspected `window.__ModuleLoader__.load({ id, factory })` client contract. No broad DSH version compatibility range is asserted.

```sh
npm ci
npm run build
npm test
npm pack
```

The packed artifact already contains `lib/client.js`, the bundle patch, the renderer software. No build is required by the installer. Install the local tarball through the target DSH profile's supported package/bundle management mechanism and enable its exported `cordis.patch.yml`. DSH discovers `./client` through the `dsh.client` manifest. The patch inserts the `dsh-meme-stickers` plugin with blob fingerprinting disabled. Exact CLI/profile editing commands vary by host; this repository does not invent a universal installation command. Merely adding an npm dependency does not necessarily activate its bundle patch.

This development task did not change an active profile. The package is not published, and its staging marketplace index advertises no releases.

## Provision a new workspace

Use an independently obtained local library with an index.json catalog. They are not automatically exposed by an unverified static resource API. Provision a new workspace-local `.memes` directory before using relative Markdown:

```sh
node scripts/provision.mjs --library /absolute/path/to/library --workspace /absolute/path/to/workspace --dry-run
node scripts/provision.mjs --library /absolute/path/to/library --workspace /absolute/path/to/workspace
```

Run these commands from the installed package directory or supply the absolute path to its script. The workspace must already exist. The script refuses any existing `.memes` directory, file, or symlink and uses exclusive file creation. It never replaces a library or touches a DSH profile. An interrupted copy may leave a partial directory; inspect that directory before retrying with a fresh destination. Do not provision over a working `.memes` link: existing libraries already work with the renderer plugin.

Choose an entry in `.memes/index.json` and emit its `markdown` value. Relative paths resolve from the chat session's workspace. For example:

```markdown
![Today should be happy](<.memes/008HappyDuck_开心鸭🐥BQB/开心鸭00002-今天也要开心鸭.gif>)
```

Absolute paths under a `.ds-bot/memes/` directory also work. No agent instruction or automatic recommendation system is installed. An external index may retain source filenames and retrieval labels; all project documentation and comments are English. Entries marked `visuallyReviewed: false` have not been visually verified, and `semanticSource: "unlabeled"` entries must not be selected automatically.

## How classification works

The actual upstream primitives renderer calls `fileImages.resolve(file.path)` before creating an image. The chat delegate resolves workspace paths and returns `api/file?path=<encoded path>`. Its final image DOM has only a rendered source and caption; no public `markdown.image` factory slot was found. The Bot skin also uses the upstream `MarkdownText` primitive.

This plugin parses the source URL and decodes the API's `path` query parameter. It accepts complete `.memes/` or `.ds-bot/memes/` local path segments, with a recognized image extension. It also supports same-origin direct image paths under these roots. It rejects external hosts and similarly named directories such as `.memes-other`. This is a local presentation convention, not an image security policy.

A small MutationObserver handles streamed messages, newly mounted rows, source changes, and virtualized row removal. The plugin adds its own scoped marker only to classified images and their single-image button wrapper. Its CSS overrules the native 640 × 360 image cap for these elements. It removes its markers and style on disposal. Images within dialogs keep the full-size preview presentation.

## Blob sources and renderer hints

Opaque `blob:` URLs contain no original filesystem path. The plugin never guesses their origin from captions, dimensions, or React private fields. A renderer integration that knows an image is a meme can add `data-dsh-meme-sticker="true"` to that image, including a blob image. This explicit hint must be maintained by the integrating renderer when it reuses DOM nodes.

Optional `fingerprintBlobs: true` in the plugin patch enables exact SHA-256 matching of same-origin blob bytes against fingerprints explicitly passed by an integration. This supports known originals even when the image source is opaque. It uses two concurrent reads, a three-second abort timeout, a cap equal to the largest configured file, a byte-size allowlist, and a 256-source cache budget per installation. No blob is fetched by default. Modified/re-encoded images and additional custom blob memes will not match; explicit provenance or a renderer-supported original-path attribute is needed for those. The plugin does not revoke host-owned blob URLs.

## Marketplace and release status

[marketplace/market-index.json](marketplace/market-index.json) is an honest Format 1 staging index with `plugins: []`. The inspected parser requires a real npm release or a pinned HTTPS Git source and publication timestamp for installable entries. No fake package publication, repository owner, timestamp, or compatibility range is supplied. Follow [marketplace/README.md](marketplace/README.md) when a real release exists.

See [VALIDATION.md](VALIDATION.md) for evidence and integration limitations. No application archive patching, arbitrary filesystem route, replacement server, or active-profile mutation is required by this source package.
