---
name: browser-sites/atlassian.net
description: Browser automation guidance for Jira and Confluence — ticket creation, issue search, field filling, service desk
disable-model-invocation: true
---

# Jira / Confluence (Atlassian Cloud) — Browser Automation Guide

## DOM & ARIA Patterns

Jira Cloud uses Atlaskit components. `data-testid` is the most stable attribute; many interactive elements also have `aria-label`.

- Global top nav: `[data-testid="navigation-container"]` — readySelector
- Create button: `[data-testid="navigation-item--create"]` or `[aria-label="Create"]`
- Issue summary field: `[data-testid="issue.views.field.summary.edit-button"]` or `#summary`
- Description editor: `[data-testid="issue.views.field.rich-text.editor-container"]`
- Priority select: `[data-testid="issue.views.field.priority.priority-field"]`
- Assignee field: `[data-testid="issue.views.field.assignee.view"]`
- Labels field: `[data-testid="issue.views.field.labels.view"]`
- Submit / Create button in dialog: `[data-testid="create-issue.form.create-button"]`
- Issue type selector: `[data-testid="issue-create.ui.fields.issue-type-field"]`
- Project selector: `[data-testid="issue-create.ui.fields.project-field"]`
- Service desk "Raise a request" form: `[data-testid="sd-issue-create-form"]`

## Standard Flows

### Create a Jira issue (standard software project — requires agent/team access)
1. `browser_navigate` → `https://{org}.atlassian.net/jira/` (internal Jira board — NOT for customer portals)
2. Wait for `[data-testid="navigation-container"]`
3. Click the "Create" button: `[data-testid="navigation-item--create"]`
4. Observe — a Create Issue modal opens
5. Select project from project dropdown if needed
6. Select issue type (Bug, Story, Task, etc.)
7. Fill "Summary" field (`#summary` or `[data-testid*="summary"]`)
8. Fill "Description" via the rich text editor
9. Set Priority, Assignee, Labels as needed
10. Click `[data-testid="create-issue.form.create-button"]`
11. After creation, the URL changes to `.../browse/{PROJECT-KEY}-{NUMBER}` — extract this as the ticket ID

### Create a Jira Service Desk request (Customer Portal)
1. `browser_navigate` → `https://{org}.atlassian.net/servicedesk/customer/portals` (NOT `/jira/servicedesk/` — that URL gives 404 on many Jira Cloud instances)
2. Click the named service desk portal link (e.g. "IT Support Service Management")
3. URL is now `/servicedesk/customer/portal/{id}`
4. Find and click the request category group (e.g. "Common Requests"), then the request type (e.g. "Get IT help")
5. URL is now `/servicedesk/customer/portal/{id}/group/{g}/create/{n}`
6. Fill Summary field (standard `<input>` — `browser_act type` directly)
7. Fill Description field — ProseMirror contenteditable: click to focus first, then type
8. Click the submit button (labelled "Send" or "Create")
9. After success, URL returns to `/servicedesk/customer/portal/{id}/...` — check page title for ticket reference

### Search for an issue
1. Click the search icon or use the keyboard shortcut `/`
2. Observe — quick search dialog appears
3. Type issue key (e.g. `ITSUP-123`) or keywords
4. Press Enter or click the top result

### Update a field on an existing issue
1. Navigate to the issue URL (`.../browse/{KEY}`)
2. Click the field to edit (most fields are click-to-edit)
3. Update the value
4. Click outside or press Tab/Enter to save

## Known Gotchas

- **"Skip to:" off-screen accessibility links**: AX indices 0–2 on every Jira page are off-screen accessibility links ("Skip to:", "Skip to Main Content"). They are outside the viewport and will time out after 30 seconds if clicked. Never click these. When looking for a clickable element, start from index 3 and above.

- **ProseMirror editor — click before type**: The Description (rich text) editor must be clicked first to gain focus before `type` will work. Pattern: (1) `browser_act click` on the element with name "Description" or role generic/textbox below the Summary field, (2) `browser_act type` with the text. Calling `type` directly without a prior `click` fails with "Element is not an input/textarea/contenteditable".

- **SSO redirect on fresh persistent session**: The first `browser_navigate` to `*.atlassian.net` redirects to the company SSO/Atlassian login page when the persistent profile has no cookies yet. Immediately switch to headed mode: call `browser_open` with `headed=true` and `profile="persistent"` on the same session, then tell the user to sign in. After login, cookies are written to disk and subsequent runs skip SSO automatically.

- **Rich text editor markdown**: Jira's ProseMirror editor auto-converts markdown syntax — type `**bold**` for bold, `- item` for bullet lists.
- **React Select dropdowns**: Priority, Assignee, Labels use React Select with virtual lists. After clicking, type to filter options; click the matching option from the dropdown list.
- **Modal timing**: The Create Issue modal has a ~500ms animation. The readySelector catches page load but not modal render — `browser_observe` after clicking Create.
- **Project-specific fields**: Custom fields (e.g. "Team", "Sprint", "Story Points") vary per project — they appear between Description and the submit button.
- **Service desk vs software projects**: Service desk URLs use `/servicedesk/customer/` path; software projects use `/jira/software/`. Different DOM.
- **Ticket ID extraction**: After issue creation, the success notification shows "Issue {KEY} created" with a link. Alternatively, parse the URL: `.../browse/PROJ-123`.

## Failure Recovery

If the Create button is not found:
1. The nav may be in compact mode — look for `[aria-label="Create"]` without the testid
2. Try pressing `c` keyboard shortcut (global Jira shortcut for Create Issue)

If a dropdown option doesn't appear:
1. Clear the current value and retype more slowly
2. The dropdown uses virtual scrolling — the option may exist but be off-screen
3. Use `browser_mark` to visually identify available options
