---
name: browser-sites/admin.microsoft.com
description: Browser automation guidance for Microsoft 365 Admin Center — user management, password reset, MFA, license assignment
disable-model-invocation: true
---

# Microsoft 365 Admin Center — Browser Automation Guide

## DOM & ARIA Patterns

M365 Admin uses a Fluent UI 2 design system with `data-automationid` as the primary stable test attribute.

- Top nav: `[data-automationid="AdminApp"]` — wait for this before interacting
- Left nav items: `[data-automationid="NavLink-*"]` e.g. `[data-automationid="NavLink-Users"]`
- Search box (users): `[aria-label="Search users"]` or `[data-automationid="searchBox"]`
- User list rows: `[data-automationid="DetailsRow"]`
- Action buttons in user detail: `[data-automationid="ResetPassword"]`, `[data-automationid="BlockSignIn"]`
- Dialog confirm button: `[data-automationid="PrimaryButton"]` or `[aria-label="Confirm"]`
- MFA panel: look for `[aria-label="Manage multifactor authentication"]` link

## Standard Flows

### Navigate to a user's account
1. `browser_navigate` → `https://admin.microsoft.com/AdminPortal/Home#/users`
2. Wait for readySelector: `[data-automationid="AdminApp"]`
3. Find search box `[aria-label="Search users"]` or `[data-automationid="searchBox"]`
4. `browser_act type` the user's email or display name
5. Wait for results — click the matching row in the user list

### Reset a user's password
1. Navigate to the user (see above)
2. On the user detail page, click `[data-automationid="ResetPassword"]` or `[aria-label="Reset password"]`
3. In the dialog: choose auto-generate or enter a new password
4. Check "Require this user to change their password" if appropriate
5. Click `[data-automationid="PrimaryButton"]` / "Reset"
6. **Capture the temporary password from the confirmation screen** (produces_variable: temp_password)

### Block / unblock sign-in
1. Navigate to user detail page
2. Click `[aria-label="Block sign-in"]` or `[data-automationid="BlockSignIn"]`
3. Toggle the checkbox in the dialog: "Block this user from signing in"
4. Click "Save changes"

### Assign or remove a license
1. Navigate to user → "Licenses and apps" tab
2. Check/uncheck the license tile (e.g. Microsoft 365 E3)
3. Click "Save changes"

### Reset MFA / require re-registration
1. Navigate to user detail → click "Manage multifactor authentication" link
2. On the MFA management page, find the user row
3. Click "Manage user settings" → check "Require selected users to provide contact methods again"
4. Click "Save"

## Known Gotchas

- **Lazy navigation**: The left sidebar collapses on narrow windows — the readySelector may load before all nav items render. If a nav link is missing, scroll the sidebar or wait 1s and re-observe.
- **Two admin UIs**: The old admin (`portal.office.com`) and the new admin (`admin.microsoft.com`) have different DOM. These patterns are for the new admin center.
- **Dialog confirmation**: After "Reset password", a second dialog confirms the reset. There are TWO buttons — don't close before capturing the generated password text.
- **Search debounce**: The user search has a 300ms debounce — wait for results to appear before clicking.
- **Guest vs member accounts**: Guest accounts show `(Guest)` suffix and have fewer options available in the detail pane.
- **Pagination**: User lists page at 100 items — search rather than scroll for large directories.

## Failure Recovery

If clicking a button fails:
1. Use `browser_mark` to check the current page state
2. The admin center often shows a loading shimmer while fetching user data — wait and re-observe
3. If the dialog is missing, the page may have navigated away — check the URL and re-navigate
4. `[data-automationid]` attributes are the most stable; if they fail, try `[aria-label]` variants
5. If MFA panel fails to load, try opening it in a new tab (some MFA settings open at `account.activedirectory.windowsazure.com`)
