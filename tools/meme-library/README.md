# Local meme library tools

Download, index and validate three selected ChineseBQB series from pinned revision `d675832ad842413679dd4a132bbfa3c311057119` of https://github.com/zhaoolee/ChineseBQB. The selected manifest records 98 files and their original Git blob SHA-1, SHA-256 and size. No image files are distributed here and no redistribution license is asserted for upstream artwork.

```sh
npm ci
node sync.mjs --library /absolute/path/to/library
node index.mjs --library /absolute/path/to/library
node validate.cjs --library /absolute/path/to/library
```

An optional `--workspace /absolute/path/to/project` on sync creates a .memes symlink, refusing an existing link to a different location. Without that option the workspace is untouched. All output stays in the explicitly selected library. Existing indexes are backed up before sync; downloads preserve original bytes, use six workers, retry three times and verify Git blob hashes. The selected manifest replaces the full upstream tree snapshot.

The generated index contains relative Markdown paths, filename-derived meanings and Chinese retrieval vocabulary. Descriptive filenames and curated rules are approximate semantic evidence, not visual review. The three unlabeled covers cannot be selected automatically. The validator uses the declared sharp dependency to decode every animation frame and check sizes, hashes and catalog references.

Use the renderer plugin under ../../plugins/dsh-meme-stickers for optional 140-pixel presentation and sticker-only bubble removal. Its provisioning script accepts an explicit local library and creates a fresh workspace-local copy without overwriting an existing target. Review upstream image rights before distributing any combined bundle.
