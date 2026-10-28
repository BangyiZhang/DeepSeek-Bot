# Shared Bot task UI

The personal fork reuses the existing Bot scheduled-task row and Settings patterns for Pi-backed work. `task-ui.js` owns the shared row, card, status and progress presentation. It accepts view data and callbacks, and imports no task engine or API client. Schedule keeps its existing service, timing, creation, grouping and confirmed deletion. `durable-task-view.js` adapts Pi state to that presentation; the chat card and Settings detail use the same adapter and components.

Settings has one Tasks destination with Scheduled tasks and Saved progress views. Existing `schedules` links, including Bot-specific create links, and `durable` links continue to resolve. A disabled Schedule service does not disable Pi, and disabled Pi does not disable Schedule. Their creation forms and services remain distinct. Pi retains its checkpoint-derived steps, immutable question/answer history, execution review and delivery status. Viewing a task never starts or resumes work; existing chat controls remain the authority for pause, resume and cancellation.

Task identities include their source; equal Schedule IDs and Pi keys cannot collide. Rendering never creates native DSH Goals, mirrors Pi state into Schedule records, or invokes a second scheduler. DSH remains the executor; Bot and Pi retain ownership and persistence respectively. No DSH packages are patched, and no internal DSH UI modules are imported.

Validate the real shared React views, old links, tab navigation, same-name source isolation, original two-click deletion, Pi saved progress and historical answers, both service-disable directions, both color schemes and a narrow column. No packaging or installation is part of this source change.
