---
name: browser-sites/okta.com
description: Browser automation guidance for Okta Admin Console — user unlock, password reset, factor reset, group management
disable-model-invocation: true
---

# Okta Admin Console — Browser Automation Guide

## DOM & ARIA Patterns

Okta Admin uses `data-se` as its primary stable test attribute.

- Header/nav: `[data-se="o-header"]` or `#header` — used as readySelector
- Left navigation links: `[data-se="nav-item-*"]`
- Search input (users): `[data-se="search-input"]` or `[placeholder*="Search"]`
- User list rows: `[data-se="user-row"]` or `tr` within `#user-list-table`
- User action menu: `[data-se="user-actions-dropdown"]`
- Dropdown items: `[data-se="dropdown-item-*"]`
- Password reset button: `[data-se="reset-password"]`
- Unlock user button: `[data-se="unlock-account"]` or text "Unlock" in action menu
- Factor reset: `[data-se="reset-factor"]` in Authenticators tab
- Dialog confirm: `[data-se="confirm-button"]` or `[aria-label="Confirm"]`

## Standard Flows

### Navigate to a user
1. `browser_navigate` → `https://{org}.okta.com/admin/users`
2. Wait for `#header` or `[data-se="o-header"]`
3. Find the search input: `[data-se="search-input"]` or `[placeholder*="Search"]`
4. Type the user's email
5. Click the matching row in results

### Unlock a locked account
1. Navigate to the user (see above)
2. On the user profile page, look for status badge — "Locked Out"
3. Click `[data-se="user-actions-dropdown"]` or the "More Actions" button
4. Click "Unlock" menu item (`[data-se="dropdown-item-unlock"]`)
5. Confirm if a dialog appears
6. Verify: status badge should change to "Active"

### Reset a user's password
1. Navigate to user profile
2. Click the "Reset Password" button or `[data-se="reset-password"]`
3. In the dialog: choose "Send user an email" or "Set a temporary password"
4. Click Confirm

### Reset an authenticator/factor
1. Navigate to user → "Security" or "Authenticators" tab
2. Find the factor to reset (e.g. "Google Authenticator", "Okta Verify")
3. Click the "Reset" link or `[data-se="reset-factor"]` next to the factor
4. Confirm the dialog

### Deactivate / suspend a user
1. Navigate to user profile
2. Click "More Actions" dropdown → "Deactivate" or "Suspend"
3. Confirm in the dialog

## Known Gotchas

- **Okta Classic vs Identity Engine**: The DOM differs significantly between the two. Classic has a table-based user list; Identity Engine has a grid. Prefer `aria-label` and text-based selectors as fallbacks.
- **Tenant-specific URLs**: Admin URL is `https://{tenant}.okta.com/admin/` — the subdomain varies per organization.
- **Page transitions**: Okta Classic does full-page reloads on navigation; Identity Engine is a SPA. The `waitForIdle` profile handles both.
- **Session expiry**: Admin sessions expire after 12h by default. If actions fail with a redirect to `/login`, the session expired.
- **Locked vs Suspended**: "Locked Out" = too many failed logins (auto-unlocks after policy time OR manual unlock). "Suspended" = admin-disabled (requires reactivation, not just unlock).
- **MFA bypass codes**: Under user → "Security" tab, admins can generate temporary one-time bypass codes.

## Failure Recovery

If user search returns no results:
1. Try searching by first name, last name, or employee ID
2. Check the search scope filter (e.g. "All users" vs "Active users only")
3. If the user is deprovisioned/deleted, search inactive users

If clicking a button fails:
1. `browser_mark` to see visual state
2. Check if a loading spinner blocks the button
3. Try the `[data-se]` attribute selector directly via a more specific XPath
