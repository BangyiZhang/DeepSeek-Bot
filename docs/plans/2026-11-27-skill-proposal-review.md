# Skill proposals: "Always allow" and Main Bot review

Status: implemented on the fork, 2026-11-27.

## Problem

After a team has been idle for a while, the learning pass may propose a new or updated
skill for a Bot. The proposal waits as a card until the user approves or declines it.
The card does not block the Bot's turns, but users with a busy team saw cards pile up,
read the "Waiting for your approval" mark as a stuck Bot, and had to approve the same
kind of change again and again.

## Decisions

1. **"Always allow" is per Bot and covers skills only.** A skill card gets a third
   button, "Always allow": it approves the card and sets `bot.learningAlways`. Later
   skill proposals of that Bot are applied as soon as the pass makes them. The rule
   shows in the Bot's details under "Always allowed" and can be removed there.
2. **A Main Bot may review skill proposals.** Settings → General → Approvals has a
   switch, "Main Bot reviews skill updates" (`prefs.learningMainReview`, off by
   default). With it on, a fresh skill proposal is sent to a Main Bot as a
   `[Skill proposal to review]` message, and the card says who is reviewing it. The
   Main Bot answers with `review_skill_proposal { proposal, approve, reason }`.
   - A Bot never reviews its own proposal. With no other Main Bot, the card waits for
     the user.
   - The tool is in the built-in `team-admin` pack, so ordinary Bots do not see it,
     and it refuses callers that are not Main Bots or when the switch is off.
   - The user can still answer the card first; a late review gets "no longer open".
3. **AGENTS.md proposals always wait for the user.** An AGENTS.md change reaches every
   Bot that works in the folder, so neither "Always allow" nor a Main Bot decides it.
4. **Every answered card says who decided.** The settled entry keeps `decidedBy`:
   `{ kind: 'user' }`, `{ kind: 'always' }`, or `{ kind: 'bot', botId, name, reason }`.
   The folded card reads "Approved automatically" or "Approved by Chief", and the Main
   Bot's reason shows when it is opened.

"Always allow" wins over Main Bot review: a Bot whose skill updates are always allowed
never sends them for review.

## Not in this change

- The phone app still answers skill cards with approve and decline only.
- The sidebar keeps marking a Bot with a waiting skill card as "Waiting for your
  approval".
