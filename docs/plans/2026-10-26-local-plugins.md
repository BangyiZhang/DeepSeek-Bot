# Local plugin integration

The fork checks application releases in BangyiZhang/DeepSeek-Bot. Main Bot selection follows every session owned by the Bot, including historical parts, and uses a consistent accent outline on hover.

Optional independently installable packages live under plugins/: Ambient Suggestions 0.2.0 uses host model inference and per-session predictive placeholders; Meme Stickers constrains recognized local images to 140 CSS pixels and removes bubbles only from sticker-only messages. Neither package is activated automatically. Both retain empty staging marketplace indexes.

Image libraries are external inputs. The original download, semantic indexing and full-frame validation tools live under tools/meme-library and require an explicit library destination. Third-party images, application archives, backups and user state are excluded.

The source also preserves the local microphone auto-gain and adaptive silence detection changes. Local speech playback is opt-in: set the browser storage key `ds-bot:tts-endpoint` to a loopback HTTP(S) TTS endpoint that accepts a text query parameter. Without it, browser speech synthesis remains the default. Playback is scoped to the voice component and stops on pause, close and unmount; late playback errors cannot restart speech after disposal. No TTS server or provider is bundled.

Validation uses isolated modeled services, synthetic DOM inputs and temporary tool libraries. A real authenticated application window and billable provider calls have not been verified. The installed application and its active profile remain unchanged.
