# DSH marketplace index

`market-index.json` is a Format 1 staging index for Ambient Suggestions. It deliberately contains `plugins: []`: no public package, release timestamp, repository owner, or hosted index URL has been verified. Loading this index therefore produces no installable plugin entries.

The schema below follows the installed `@deepseek-ai/dsh-plugin-market-index` parser inspected during development. Format validation confirms document structure; it does not verify package availability, ownership, compatibility, or successful installation.

## Format 1 fields

| Location | Field | Rule |
| --- | --- | --- |
| Root | `format` | Required integer value `1`. |
| Root | `title` | Required nonempty string, or localized object containing `en`. |
| Root | `description` | Optional text using the same localization rules. |
| Root | `metadata` | Optional declarations of `categories`, `labels`, and `sortKeys`. |
| Root | `plugins` | Required array; an empty array is valid. |
| Plugin | `name` | Required valid npm package name; unique within the index. |
| Plugin | `title`, `description` | Optional text using the same localization rules. |
| Plugin | `author`, `homepage`, `repository`, `icon` | Optional presentation and source metadata. |
| Plugin | `metadata` | Optional single `category`, `keywords`, `labels`, and numeric `sortKeys`. Referenced IDs must be declared at the root. |
| Plugin | `versions` | Required nonempty array with unique exact SemVer versions. |
| Version | `version` | Required exact SemVer, such as `0.1.0`. |
| Version | `publishTimestamp` | Required integer Unix timestamp in seconds, from `0` to less than `100000000000`. Use the actual publication time. |
| Version | `source` | Required object with `type: "npm"` or `type: "git"`. |
| Version | `engines` | Optional object with a valid `dsh` SemVer range. A range is a maintainer assertion, not a test result. |

For npm sources, `source.registry` is optional. The parser derives the install target as `name@version`; `source.spec` is not a Format 1 field. For Git sources, provide an HTTPS repository `url`, a lowercase 40-character hexadecimal `commit`, and an optional relative package directory `path`. A branch name or tag is not a substitute for the pinned commit.

Repository metadata uses an object with `url` and optional `directory`. Relative icons resolve against the index URL. HTTPS icons are accepted; HTTP icons must use the index origin. Supported base64 image data URLs are limited to 32 KiB of decoded data.

The parser ignores unknown members. Fields such as `schema`, `defaultVersion`, `publishedAt`, `package`, top-level plugin `categories`, and `tags` therefore do not provide the behavior their names might suggest. Versions are sorted by descending SemVer precedence.

## Illustrative release entry

The following complete index is a schema example, not a published catalog. Its `example.com` URLs and timestamp `0` are placeholders. Replace them with verified project metadata and the actual publication timestamp before use. The npm version must exist in the selected registry. Omit an engine range until the supported DSH range is established.

```json
{
  "format": 1,
  "title": "Ambient Suggestions",
  "description": "Follow-up prompt suggestions for DSH.",
  "metadata": {
    "categories": {
      "productivity": { "title": "Productivity" }
    },
    "labels": {
      "community": { "title": "Community" }
    },
    "sortKeys": {
      "updated": { "title": "Recently updated", "order": "desc" }
    }
  },
  "plugins": [
    {
      "name": "dsh-ambient-suggestions",
      "title": "Ambient Follow-up Suggestions",
      "description": "Local keyword-based follow-up prompts above the composer.",
      "author": "Example Maintainers",
      "homepage": "https://example.com/ambient-suggestions",
      "repository": {
        "url": "https://example.com/maintainer/ambient-suggestions"
      },
      "icon": "../icon.svg",
      "metadata": {
        "category": "productivity",
        "keywords": ["composer", "follow-up", "suggestions"],
        "labels": ["community"],
        "sortKeys": { "updated": 0 }
      },
      "versions": [
        {
          "version": "0.1.0",
          "publishTimestamp": 0,
          "source": { "type": "npm" }
        }
      ]
    }
  ]
}
```

An optional version compatibility declaration looks like `"engines": { "dsh": ">=0.2.0" }`; this is illustrative and does not claim that range has been tested. An optional custom npm registry looks like `"source": { "type": "npm", "registry": "https://registry.example.com/" }`.

A Git source has this shape; both the URL and all-zero commit below are illustrative and must be replaced with a real repository and commit containing the installable package:

```json
{
  "type": "git",
  "url": "https://example.com/maintainer/ambient-suggestions",
  "commit": "0000000000000000000000000000000000000000"
}
```

If the package is inside a repository subdirectory, add `"path": "packages/ambient-suggestions"`. The parser produces an installation target in the form `git+https://…git#<commit>&path:/<directory>`.

## Validate with the installed parser

Run this from an environment where `@deepseek-ai/dsh-plugin-market-index` is installed and importable. It is a host tooling package, not assumed to be a development dependency of this repository:

```sh
node --input-type=module <<'JS'
import { readFile } from 'node:fs/promises';
import { parseMarketIndex, marketInstallTarget } from '@deepseek-ai/dsh-plugin-market-index';

const value = JSON.parse(await readFile('marketplace/market-index.json', 'utf8'));
// This URL supplies a validation base only; it does not advertise a hosted index.
const index = parseMarketIndex(value, 'https://example.com/marketplace/market-index.json');
console.log(`Valid Format ${index.format}: ${index.plugins.length} plugin(s)`);
for (const plugin of index.plugins) {
  for (const version of plugin.versions) {
    console.log(plugin.name, version.version, marketInstallTarget(plugin.name, version));
  }
}
JS
```

Use the exact installed parser when checking changes. A JSON syntax check alone will not catch Format 1 errors. Also validate the example after replacing placeholders, since unknown members are silently dropped.

## Preparing a real catalog

1. Build and test the package, inspect its packed contents, and verify integration in the target DSH web host.
2. Establish the public repository URL, package ownership, release artifact, and supported DSH versions.
3. Publish through the maintainers' authorized release process, or select a real pinned Git commit containing a package that can be installed and built.
4. Add the real release entry with its actual timestamp and source. Validate both schema and generated installation target.
5. Host the index and icon at reachable URLs. Test the actual index URL and installation in a disposable profile before advertising instructions.

A DSH version that supports custom market sources may accept the hosted JSON URL in its source-management interface. Interface labels vary by version. This repository does not claim a live source URL or an available marketplace installation.
