# Local Antigravity CLI model source

## Behavior

An installed `agy` becomes a model provider through DSH's public `LlmAdapter` and `ctx.llm.registerAdapter` APIs. Bots select `local-antigravity/default` in the same picker as API models and local Codex. The adapter passes no model, effort or authentication override, so the installed CLI supplies these defaults. DS Bot does not read, copy or rewrite its credentials or configuration. `localAntigravity: false` disables discovery; `antigravityCommand` selects an explicit executable.

## Protocol and tools

Each DSH model request starts a fresh `agy --input-format stream-json --output-format stream-json --json-schema … --mode plan --sandbox --disable-slash-commands`. The prompt, system instructions, role-labelled messages, tool call identities and available tool schemas travel through stdin. The pipe closes after one input event. We do not pass `--continue` or `--conversation`; Bot conversations cannot accidentally resume a terminal session or another Bot's history.

Unlike Codex's dynamic functions, Antigravity's documented headless interface returns tool requests as schema data: `{text, tool_calls: [{name, arguments}]}`. Every call must name a tool from this request and encode a JSON object. The adapter validates the entire final result before emitting DSH tool-call blocks; DSH then performs its usual tool permission checks and execution. A subsequent invocation carries the recorded results. The internal `finish` tool used by AGY to submit schema output is accepted as protocol completion; the validated terminal `structured_output` remains authoritative. Other native CLI tool/subagent events fail the request and stop its process; they are never interpreted as a DSH tool result.

The schema constrains only the terminal result, so partial agent text stays buffered. Replies currently appear together after successful validation, without token-by-token streaming. Nonzero process exits, non-success terminal status, empty replies, malformed output and unexpected tools are visible errors. Provider diagnostics and stderr are never forwarded. A known unsupported-location error receives a fixed actionable message without exposing raw diagnostics.

## Process lifecycle and limits

Every invocation uses an empty temporary working directory, removed on completion, cancellation or error. It never starts in the Bot's data directory. Plan mode, sandbox and instructions reduce native activity; they do not override the user's global Antigravity hooks/MCP settings or provide a separate OS identity. This adapter is for a trusted local CLI installation. It does not enable dangerous permission bypass flags. Cancellation kills this invocation's process group with SIGTERM followed by SIGKILL if needed; plugin disposal closes all active invocations.

The configured-model entry advertises text input and a conservative 128k context budget. It does not expose native AGY conversations, image input, native tool execution or independent model/effort selection. Change model and effort through `agy` itself. Fresh CLI processes and complete DSH history add overhead. Token usage uses the CLI's uncached input, output and separate cache-read counts.

## Verification

Spawned CLI fixtures exercise real NDJSON framing, DSH's BlockAssembler, tool round trips, concurrent conversations, invalid results, diagnostic redaction, cancellation and temporary-directory cleanup. Provider-page tests cover both local CLIs together. Live desktop verification additionally checks discovery and a real invocation. Successful inference depends on the account and service: on 2026-10-22 this machine's default model was rejected with `User location is not supported for the API use`, before any token generation. That was a live service limitation; mock protocol success alone did not demonstrate live generation success. A subsequent live run on the same day succeeded after connectivity changed and revealed that schema completion emits a `tool` step named `finish`. The adapter now accepts that exact internal tool and tests both name fields, conflicting names and subagent metadata. A real adapter tool round trip completed with `AGY_TOOL_OK`. The updated desktop returned a live reply, and an isolated real DSH host executed `list_bots` and returned the Chief roster with `AGY_LIVE_HOST_PASSED` (two model steps, 8ms host tool execution).

Protocol reference: [Antigravity headless mode](https://www.antigravity.google/docs/cli/headless/).


## CLI progress and elapsed time

DS Bot now publishes fixed CLI phases (starting, waiting, preparing, validating, completed, failed, stopped) with a host timestamp through its existing state/feed APIs. No diagnostic or partial schema text enters this channel. The activity row creates a temporary chat-flow slot when the shell has not yet created its running slot, so it appears before the first reply chunk. Its local clock ticks each second. The activity row disappears when work finishes; completion totals remain internal and are not shown in the chat. While active, elapsed time includes CLI startup and tool handoffs. These latest-run statuses are in memory and are not a new session history format.

Antigravity does not expose readable model thoughts in the headless events used by this adapter. Its activity label describes observed protocol stages and does not invent reasoning text or classify all waiting as model thinking. Codex public reasoning summary deltas map to DSH reasoning blocks, using its existing expandable thinking UI and session storage. Provider secrets, encrypted reasoning and raw CLI logs stay outside the progress display.
