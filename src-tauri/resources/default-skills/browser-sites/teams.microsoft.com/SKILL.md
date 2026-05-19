---
name: browser-sites/teams.microsoft.com
description: Browser automation guidance for Microsoft Teams — shadow DOM, data-tid selectors, navigation patterns
disable-model-invocation: true
---

# Microsoft Teams — Browser Automation Guide

## DOM & ARIA Patterns

Teams is built on Fluent UI with heavy shadow DOM use. Key attribute: `data-tid` — Microsoft's stable test identifier.

- App navigation: `[data-tid="app-bar-*"]` (e.g. `[data-tid="app-bar-chat"]`)
- Team/channel list: `[data-tid="channel-*"]`
- Message compose box: `[aria-label="New message"]` or `div[contenteditable="true"]`
- Send button: `[aria-label="Send message"]`
- Search: `[data-tid="app-header--search-input"]`

## Standard Flows

### Navigate to a channel
1. `browser_observe` after navigation — wait for `[data-tid="app-layout-area--main"]`
2. Find the team in the sidebar — `data-tid` contains the team name
3. Click to expand team, then click channel
4. Observe again — compose box becomes available

### Send a message in a channel
1. Find compose box by `aria-label="New message"` or contenteditable div
2. `browser_act type` your message (Teams uses contenteditable, not a standard textarea)
3. `browser_act press Enter` or click the Send button `[aria-label="Send message"]`

### Search for a person or message
1. Click `[data-tid="app-header--search-input"]`
2. Type search query
3. Observe results — they appear in a dropdown with `role=option`

## Known Gotchas

- **Shadow DOM**: Many Teams components are inside shadow roots. If `getByRole` fails, use `browser_mark` to visually identify elements, then try `[data-tid="..."]` selectors
- **contenteditable compose box**: Teams uses a rich text editor, not `<textarea>`. Use `browser_act type` which uses `fill()` — it works on contenteditable in Playwright
- **Loading is slow**: Teams takes 15–30s to fully load on first sign-in. The site profile auto-waits for `[data-tid="app-layout-area--main"]` but some features load lazily afterward
- **Meeting join buttons**: `[data-tid="join-btn"]` or `[aria-label="Join"]`
- **Notification banners** may overlay elements — they dismiss automatically after ~5s

## Failure Recovery

If navigation or clicking fails:
1. Use `browser_mark` to see the current visual state
2. Check if a loading spinner is still visible — wait with another `browser_observe`
3. Try `[data-tid="..."]` selectors directly if role-based matching fails
4. Teams frequently re-renders on focus — add a small delay and re-observe
