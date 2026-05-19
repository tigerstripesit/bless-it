---
name: browser-sites/linear.app
description: Browser automation guidance for Linear — issue creation, team navigation, cycle/project management, priority setting
disable-model-invocation: true
---

# Linear — Browser Automation Guide

## DOM & ARIA Patterns

Linear is a React SPA with a keyboard-first design. DOM attributes are minimal — rely on `aria-label`, text content, and role-based selectors.

- Sidebar: `.sidebar` or `[data-view-id]` — readySelector
- "Create issue" button: `[aria-label="Create issue"]` or `[aria-label="New issue"]`
- Issue title in modal: `[placeholder="Issue title"]`
- Issue description editor: `.ProseMirror` or `[aria-label="Issue description"]`
- Priority selector: `[aria-label="Priority"]` or text "No priority"
- Status selector: `[aria-label="Status"]`
- Assignee: `[aria-label="Assignee"]`
- Team selector in create modal: `[aria-label="Team"]`
- Label selector: `[aria-label="Label"]`
- Submit / "Create issue" button: `[aria-label="Create issue"]` in the modal footer
- Issue list: `[data-entity-id]` items in the main panel
- Search: `[aria-label="Search"]` or Cmd+K

## Standard Flows

### Create an issue
1. `browser_navigate` → `https://linear.app/{workspace}/team/{team}/issues`
   (or use the global `https://linear.app/{workspace}`)
2. Wait for `[data-view-id]`
3. Press `C` keyboard shortcut (global "Create issue" shortcut) or click `[aria-label="Create issue"]`
4. Observe — "Create issue" modal appears
5. Type the issue title in `[placeholder="Issue title"]`
6. Set Priority, Status, Assignee from the modal sidebar
7. Optionally add description in `.ProseMirror`
8. Click "Create issue" button or press `Cmd+Enter`

### Navigate to a team
1. Find the team in the left sidebar
2. Click the team name — its issues view loads
3. Observe — `[data-view-id]` updates to the team's context

### Update an issue's status
1. Navigate to the issue or find it in the list
2. Click the status circle/badge to the left of the issue title
3. Select new status from the dropdown

### Search for an issue
1. Press `Cmd+K` or click the search icon
2. Type the issue title or ID (e.g. `ENG-123`)
3. Press Enter on the matching result

## Known Gotchas

- **Keyboard-first**: Most Linear actions have keyboard shortcuts. When DOM clicks fail, try the keyboard shortcut (`C` = create, `Cmd+K` = search, `E` = edit, `Backspace` = delete selected).
- **ProseMirror editor**: Description uses ProseMirror contenteditable. Use `browser_act type` for plain text. Markdown works: `**bold**`, `- list items`, `# heading`.
- **SPA transitions**: Linear uses React Router; the `preActDelayMs: 100` profile handles most SPA re-renders. If elements disappear after clicking, observe again.
- **Workspace slug**: URLs use `/{workspace}/` slug, not a numeric ID — match against the user's workspace.
- **Cycle/sprint context**: Issues in a cycle show a cycle badge. To add an issue to a cycle, right-click the issue → "Add to cycle".
- **Modal overlay**: The create issue modal uses a portal overlay — it's at the DOM root, not inside the team view. Always observe after opening the modal.

## Failure Recovery

If the create modal doesn't appear:
1. Check if a different modal is already open (e.g. search, command palette)
2. Press `Escape` to close any open overlay, then try again
3. Try the keyboard shortcut `C` rather than the button click
