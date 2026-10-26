# DSH Ambient Suggestions

Version 0.2 replaces fixed keyword predictions with a real, cancellable model call. After a completed assistant answer, an empty composer can display a short predicted next message. Press Tab to insert it; acceptance never sends the message.

## Model selection

The default model setting is empty, meaning inherit the conversation's pending model selection, then its last request model, then the deployment default. No prediction provider is selected silently as a fallback. The plugin settings card lists installed providers and their current model catalogs. Choose **Inherit current conversation model** to restore inheritance. A configured route uses `provider/model`; model IDs may contain additional slashes.

Configuration uses DSH's standard Schemastery `Config` with volatile fields. Changes persist through the standard revisioned `configForms` settings scope. The supplied bundle entry ID is `client-ui-ambient-suggestions`; the custom settings card uses that namespace. If renaming the entry, adjust the settings adapter to match.

```yaml
- insert:
    - id: client-ui-ambient-suggestions
      name: dsh-ambient-suggestions
      config:
        model: ''
        timeoutMs: 8000
```

## Inference and lifecycle

The browser submits only a session ID, completed-turn key, and language preference through strict Typert RPC. The host reads the latest two turn-outline previews itself and calls the existing `llm.prepareCall()` service. Conversation text is not trusted from a browser request. The system instruction asks for one short plain-text next-message phrase or question in the user's language. No tools are declared. Requested output is capped at 96 tokens and normalized to at most 120 characters.

The inspected turn-outline previews are short (approximately 50 user characters and 120 assistant characters per turn). Predictions therefore have limited context, rather than the complete transcript. The installed adapter controls actual billing and token behavior; external CLI adapters may ignore an output cap. Each auxiliary call uses the configured provider and its normal credentials and may incur costs.

Only one request is attempted per mounted completed turn. Typing, adding attachments, starting a new turn, pending interactions, switching sessions, or unmounting cancels the browser call and clears the preview. AbortSignal travels through Typert to model preparation and streaming. Generation fences discard late results even if an adapter ignores cancellation. The host also checks the latest turn before and after inference and enforces a deadline. Failed, unavailable, empty, or cancelled predictions leave the native fallback placeholder intact. There is no regex prediction fallback.

The preview is scoped to a hidden per-session dock anchor. Existing session ownership protections and the DS Bot skin compatibility overrides are preserved. The plugin restores real text metrics and suppresses the Bot skin's fallback pseudo-element only while showing its own preview.

## Build and package

Install development dependencies in a DSH development environment that supplies the declared host peer packages:

```sh
npm install --legacy-peer-deps
npm run build
npm test
npm pack
```

The browser bundle includes strict RPC schemas and the browser-safe `remote-info` helper; React is supplied by DSH. If building next to an extracted packaged runtime rather than a normal checkout, `DSH_REMOTE_INFO` can specify that installed browser-safe helper's absolute path. It is a build input, not embedded in the shipped package.

Use the target profile's supported package/bundle installer for the tarball, then enable its bundle patch. Merely editing the bundle list does not install dependencies. The package declares required DSH host APIs as peers to avoid embedding a second runtime. This development task does not claim one-click public installation or a hosted marketplace release.

## Validation and release status

See [VALIDATION.md](VALIDATION.md) for the exact checks and remaining limits. The Format 1 index under [marketplace](marketplace/README.md) remains a valid empty staging index until a real source is published. No public release or broad compatibility range is asserted. The inspected runtime is DSH 0.2.1-rc.2; these APIs may change.

Software is licensed under [MIT](LICENSE). All project documentation and comments are English.
