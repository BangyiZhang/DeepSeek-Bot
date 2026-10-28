# Durable task step progress

The personal fork's conversation card shows the saved business-stage plan, not inferred tool calls or an estimated percentage. Existing creation records supply the stage headings; the API projects bounded, redacted first-line titles without exposing the worker's saved context or system instructions. Old tasks without creation metadata keep numbered fallback labels.

The card and Settings share a compact ordered list. Completed stages use a check; the current stage keeps its number and an explicit working/waiting/paused state; later stages remain pending. Terminal interruptions show the interrupted stage and distinguish later stages that were not run. A collapsed plan retains the completed/total count. Progress derives from Pi's saved checkpoints and outcomes and remains consistent after restart, pause, user questions and cancellation. No completed stage or task is resubmitted by this UI.

Use existing theme colors, typography and controls with a quiet divider and numbered markers. Support both color schemes, narrow conversation columns, keyboard expansion and semantic current-step information. Initial tool arguments provide headings while the first status request loads. API titles remain authoritative after refresh and for historical cards.
