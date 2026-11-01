# Selected-text reply

The personal fork extends the existing message Reply action. Selecting text in one Bot or user message shows a small “Quote selection” action next to the visible selection. It uses the existing message Reply icon, menu surface and quote insertion path. Clicking it inserts the selected text as a Markdown quote into the current chat's composer, keeps the existing draft, and focuses the composer. It does not send a message.

- A selection belongs to one rendered message in the active chat. Crossing messages, selecting another chat, selecting composer text or selecting message controls does not offer a reply. Formatted text, links and code remain selectable.
- Selected quotes preserve the full selected text, indentation and line breaks; every line is quoted. The existing whole-message Reply keeps its 200-character summary behavior. When its own message has a selection, that Reply button also quotes the selection.
- The action follows the visible endpoint of forward/backward selections, stays inside the visual viewport, and disappears when the selection clears, leaves view, the window loses focus or Escape is pressed. Switching chats or opening a modal disables the old action. Clicking the action preserves the native selection until the quote is captured.
- One chat-level selection observer serves all message bodies. Only message bodies carry the quote-session marker; tool output, input fields, attachment cards and unrelated panels do not gain global quote behavior.
- The implementation stays in the client and uses documented composer input actions. It adds no Host endpoint, stored conversation schema, task dispatch or DSH modification.

Validation covers real DOM ranges, nested formatting, whitespace and cross-message rejection, viewport bounds, the shared composer with an existing draft, full-message fallback, user-message selection, long/multiline quotes, Escape, modal and session cleanup. Browser verification uses a disposable source Host with the mock model, including both color modes and the actual composer insertion path. No installer is built.
