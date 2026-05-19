---
name: browser-sites/web.whatsapp.com
description: Browser automation guidance for WhatsApp Web — interaction patterns, ARIA layout, gotchas
disable-model-invocation: true
---

# WhatsApp Web — Browser Automation Guide

## DOM & ARIA Patterns

WhatsApp Web is a React SPA. All interactive elements use `aria-label` — **never rely on text content or CSS classes**.

- Chat list rows: `[aria-label="[contact name]"]` on a `<div role="listitem">`
- Search box: `role=textbox` with `aria-label="Search input textbox"`
- Message input: `role=textbox` with `aria-label="Type a message"` (only visible after opening a chat)
- Send button: `[aria-label="Send"]`
- New chat / icons: `[aria-label="New chat"]`, `[aria-label="Menu"]`

## Standard Flows

### Open a chat with a contact
1. `browser_observe` (wait_for_idle already auto-applied by site profile)
2. Find the textbox with `name="Search input textbox"` and `browser_act type` the contact name
3. `browser_observe` again — results appear as `role=listitem` with `aria-label="[name]"`
4. `browser_act click` on the contact row (match by aria-label)
5. `browser_observe` — message input now visible

### Send a message
1. Find `role=textbox name="Type a message"` — index it from observe
2. `browser_act type` the message text
3. `browser_act click` on `[aria-label="Send"]` OR `browser_act press Enter`

### Check last message in a chat
- After opening a chat, observe the page — messages appear as `role=row` items
- Last message text is in a `role=text` node inside the most recent row

## Known Gotchas

- The page uses `data-testid` attributes internally but they change between releases — prefer `aria-label`
- After searching, the result list takes ~500ms to render — call `browser_observe` again rather than immediately clicking
- If message input isn't visible, the chat isn't open yet — search and click the contact first
- Long contact names are truncated in `aria-label` — search by first name if full name fails
- WhatsApp Web requires an active phone connection — if the page shows a QR code, the session is not authenticated

## Failure Recovery

If `browser_act` fails with a timeout:
1. Call `browser_mark` to get an annotated screenshot — identify the element visually
2. Try `browser_observe` with `wait_for_idle: true` to get a fresh snapshot after the SPA re-renders
3. If the contact row has `role=text` not `role=listitem`, click the parent container instead
