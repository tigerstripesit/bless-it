---
name: browser-sites/app.slack.com
description: Browser automation guidance for Slack — data-qa selectors, channel navigation, message sending
disable-model-invocation: true
---

# Slack — Browser Automation Guide

## DOM & ARIA Patterns

Slack uses `data-qa` as its primary stable test attribute — more reliable than `aria-label` which can change with locale.

- Channel list sidebar: `[data-qa="channel_sidebar"]`
- Channel items: `[data-qa="virtual_list_item"]` containing `[data-qa="channel-item"]`
- Message input: `[data-qa="message_input"]` or `[aria-label="Message Input"]`
- Send button: `[data-qa="texty_send_button"]`
- Search: `[data-qa="search_input"]` or `[aria-label="Search Slack"]` button
- User name in message: `[data-qa="message_sender_name"]`
- Reactions: `[data-qa="reactions_row"]`
- Thread reply: `[aria-label="Reply in thread"]`
- DM: look for `[data-qa="direct_messages_section"]` in sidebar

## Standard Flows

### Navigate to a channel
1. `browser_observe` — sidebar should be visible after auto-wait
2. Find the channel in the sidebar — `[data-qa="channel-item"]` with channel name as aria-label or text
3. Click the channel item
4. Observe — message input becomes visible

### Send a message
1. Find message input: `[data-qa="message_input"]`
2. `browser_act type` your message
3. `browser_act press Enter` (preferred) or click `[data-qa="texty_send_button"]`

### Search for a message or person
1. Click the search button `[aria-label="Search Slack"]`
2. Observe — search input appears: `[data-qa="search_input"]`
3. Type query, press Enter
4. Observe results

### Open a DM
1. Find `[data-qa="direct_messages_section"]` in sidebar
2. Click existing DM or use `+` button for new DM
3. Type recipient name in the DM search

## Known Gotchas

- **data-qa over aria-label**: Slack's aria-labels are inconsistent between Slack versions — always prefer `data-qa` attributes
- **Virtual list**: The channel sidebar uses a virtual list; channels not in viewport may not be in the AX tree — scroll the sidebar before observing
- **Message input is a contenteditable div**: Use `browser_act type` (not press) for text input
- **Emoji in messages**: Typing `:emoji_name:` in Slack auto-converts — this works fine with `browser_act type`
- **Workspace switching**: If you have multiple workspaces, the URL changes to `app.slack.com/client/{workspace_id}` — the site profile still matches
- **Threads vs main channel**: Thread reply input has `aria-label="Reply in thread"` — distinct from the main `message_input`
- **Notifications**: Notification toasts can temporarily cover elements — they fade after 3–5s

## Failure Recovery

If channel navigation fails:
1. The virtual list may not have rendered the target channel — use `browser_act scroll` in the sidebar
2. Call `browser_observe` again after scrolling
3. Use `browser_mark` to see current state and identify visible channel items
4. As last resort, use the search feature to navigate: search the channel name and click the result
