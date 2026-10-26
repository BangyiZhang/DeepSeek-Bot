# Bot-owned durable tasks

The user requested this evolution on the personal fork. DSH is unchanged: it remains the only model/tool executor. DS Bot owns task admission, identity, context, capabilities and results; Pi Durable owns the persistent workflow, allocated sessions, checkpoints and recovery.

New tasks from chat and Settings belong to a specific Bot. Their dedicated DSH sessions are reserved in the existing Pi creation record, not adopted into the standalone DSH Agent. The plugin rebuilds a separate task-session owner index from that record before executing recovered work. These sessions are neither private-chat segments nor group sessions: ordinary Bot conversation switching/recovery must not drive them.

Admission freezes a bounded, redacted snapshot of recent private-chat messages and own/team memory, plus Bot instructions, selected model/effort, working directory, supported permission preset, callable tools, attached capability names and a fingerprint of their definitions. MCP/skill mounting reuses the Bot capability subsystem and its existing approvals/secret authorization. Credential values are never copied into task metadata. Recovery verifies the same capability definitions and permissions; configuration drift blocks execution instead of silently changing delegated access. Capability mounting must finish successfully before tools are captured or a stage is admitted.

Task sessions receive Bot identity and can read that Bot's conversation and memory through scoped read-only tools. They may use the captured MCP/skill capabilities and ordinary delegated tools. They cannot change the roster, capabilities, permissions, create recursive tasks, or invoke the application installer. Team collaboration and installer handoff remain controlled by the original Bot chat; this change does not grant unrestricted team powers to task execution sessions.

Task progress contributes to the originating Bot's work status. Settings chooses a Bot and routes new submissions through the same admission path; results return to that Bot. The task detail opens the owning Bot chat and retains saved stage outputs. User chat injection into a reserved task session is refused before execution. A Bot with unfinished or unreconciled work cannot be deleted.

Existing stored workflows keep their allocated sessions and original execution contract. Legacy DSH Agent workflows continue to recover on their original path. No running task is automatically reassigned or replayed to migrate ownership. Unknown/missing owners, changed execution scope and ambiguous DSH admission remain reconciliation cases.

Acceptance uses isolated mock profiles: Bot ownership without DSH Agent allocation, bounded context and redaction, actual skill/MCP use, owner-only history/memory access, capability drift/revocation, restart recovery, pause/continue/cancel, report deduplication, existing workflow compatibility, and packaged UI. Tests never use the user's own team or credentials.
