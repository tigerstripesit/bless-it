---
name: browser-sites/mail.google.com
description: Browser automation guidance for Gmail — compose, thread navigation, label management
disable-model-invocation: true
---

# Gmail — Browser Automation Guide

## DOM & ARIA Patterns

Gmail is a complex SPA. Elements use a mix of `aria-label` and `data-tooltip`.

- Compose button: `[aria-label="Compose"]`
- Inbox thread rows: `role=row` in the thread list table
- Email subject in thread: `role=heading` or `h2`
- Thread list: `[role="main"]` contains `[role="table"]` with rows
- Reply/Forward: `[aria-label="Reply"]`, `[aria-label="Forward"]`
- Send button in compose: `[aria-label="Send ‪(Ctrl-Enter)‬"]` (note Unicode chars)
- To/CC/BCC fields: `[aria-label="To recipients"]`
- Subject field: `[aria-label="Subject"]`
- Message body in compose: `[aria-label="Message Body"]` contenteditable div
- Search box: `[aria-label="Search mail"]`
- Labels in sidebar: `[aria-label="[Label name]"]`

## Standard Flows

### Compose and send an email
1. `browser_observe` — wait for `[role="main"]`
2. Click `[aria-label="Compose"]`
3. Observe — compose window appears
4. Type in To field: find `[aria-label="To recipients"]`, type address
5. Press Tab to move to Subject, type subject
6. Click `[aria-label="Message Body"]`, type message
7. Click Send button (contains "Ctrl-Enter" in aria-label — use partial match or `browser_mark`)

### Open an email thread
1. Find the row in the thread list — `role=row` nodes with the sender/subject as name
2. Click the row
3. Observe — email content loads in `[role="main"]`

### Search for emails
1. Click `[aria-label="Search mail"]`
2. Type query, press Enter
3. Observe results as thread rows

## Known Gotchas

- **Unicode in aria-labels**: Send button has Unicode non-breaking spaces — use partial aria-label matching or `browser_mark`
- **Compose window is a dialog**: It appears as a floating `role=dialog` — observe after clicking Compose
- **Thread rows are complex**: Each row has many nested spans; the clickable area is the whole `role=row`
- **Labels in sidebar**: Left sidebar has `[role="navigation"]` with label links — each has its own aria-label
- **Keyboard shortcuts**: Gmail intercepts many keys — use `browser_act press` carefully (Tab, Enter are safe)
- **New Gmail vs Classic**: Modern Gmail (default) has different structure than the "basic HTML" view

## Failure Recovery

If compose window doesn't appear after clicking Compose:
1. Check if a "Multiple Compose" dialog appeared — click "New Window" or "Compose"
2. Use `browser_mark` to see current state visually
3. Gmail may have reloaded — re-observe from scratch
