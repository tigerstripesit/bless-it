---
name: browser-sites/service-now.com
description: Browser automation guidance for ServiceNow — incident creation, CMDB lookups, request fulfillment, user management
disable-model-invocation: true
---

# ServiceNow — Browser Automation Guide

## DOM & ARIA Patterns

ServiceNow has multiple UI generations: Classic (pre-2021 iFrame-based) and Polaris/Next Experience (post-2022 SPA). Both are common in enterprises.

### Classic UI (iFrame-based)
- Main content loads inside `<iframe id="gsft_main">` — Playwright must interact inside the frame
- Form fields: `[name="{field_name}"]` e.g. `[name="short_description"]`, `[name="description"]`
- Reference fields (lookup): `[id="{table}.{field}"]` + autocomplete dropdown
- Submit button: `[id="sysverb_insert"]` (new record) or `[id="sysverb_update"]` (edit)
- Navigation sidebar: `[id="gsft_nav"]` containing an iframe

### Next Experience (Polaris)
- No iFrames — flat DOM
- Form fields: `[aria-label="{label}"]` or `.now-inputs-text input`
- Submit: `[aria-label="Submit"]` or `.btn-primary`

**Detect which UI**: If `#gsft_main` iframe exists → Classic. If `[data-macroname="sp-page-root"]` or `.now-experience-root` → Polaris.

## Standard Flows

### Create an Incident (Classic UI)
1. `browser_navigate` → `https://{instance}.service-now.com/incident.do?sys_id=-1`
   (The `sys_id=-1` opens a new incident form)
2. Wait for `#gsft_main` iframe to appear
3. **Switch to iframe context** — Playwright does this automatically via AX snapshot; the site profile handles it
4. Fill `[name="short_description"]` with the issue summary
5. Fill `[name="description"]` with full details
6. Set Caller: click `[name="caller_id"]` lookup field, type user name, select from autocomplete
7. Set Category and Subcategory dropdowns
8. Set Impact and Urgency (auto-calculates Priority)
9. Click `[id="sysverb_insert"]` to submit
10. After save, the URL contains `sys_id=...` and page shows the incident number (INC0012345)

### Create an Incident (Next Experience / Polaris)
1. `browser_navigate` → `https://{instance}.service-now.com/now/workspace/agent/incidents/create`
2. Wait for `.now-experience-root` or `[aria-label="Incident form"]`
3. Fill `[aria-label="Short description"]`
4. Fill `[aria-label="Description"]`
5. Set Caller via reference field
6. Submit with `[aria-label="Submit"]`

### Look up a user in CMDB / User table
1. Navigate to `https://{instance}.service-now.com/sys_user_list.do`
2. Use the search/filter bar: `[name="sys_user.user_name"]` or `[name="sys_user.email"]`
3. Enter value and press Enter
4. Click the user in the results list

### Approve a Request
1. Navigate to "My Approvals" or the request item URL
2. Find the Approve/Reject buttons: `[id="sysverb_oe_end_approval_approve"]` or `[aria-label="Approve"]`
3. Optionally add comments in `[name="approval_set.comments"]`
4. Click Approve

## Known Gotchas

- **iFrame-first**: Classic ServiceNow loads the main content in an `<iframe id="gsft_main">`. Playwright's AX snapshot traverses iframes automatically, but if elements aren't found, ensure the frame is visible and loaded.
- **Slow rendering**: ServiceNow is notorious for slow DOM updates — the site profile sets `preActDelayMs: 300`. Reference field autocompletes can take 500ms+ to appear after typing.
- **Reference fields**: Many fields (Caller, Assignment Group, Category) are `sys_id` lookups displayed as text. Click the field → type → wait for autocomplete dropdown → click the matching item. Don't try to set the hidden `sys_id` field directly.
- **UI Policy restrictions**: Some fields are hidden or read-only based on form state (e.g. Assignment Group is read-only until Category is set). Fill fields in top-to-bottom order.
- **Multiple instances**: Organizations have DEV, UAT, PROD instances — check the subdomain in the URL.
- **Session timeout**: ServiceNow sessions expire after 30min of inactivity by default. Look for the login redirect.
- **Mandatory fields**: ServiceNow won't save if mandatory fields are empty — they show a red border. The submit button may be grayed out.

## Failure Recovery

If form submission fails:
1. Check for red-bordered mandatory fields — fill them before re-submitting
2. Use `browser_mark` to visually see the form state
3. For Classic UI, if the iframe isn't found, the page may still be loading — wait for `#gsft_main` readySelector
4. If autocomplete doesn't appear after typing in a reference field, clear the field and try typing more slowly (the site profile's `preActDelayMs` helps)
5. For "UI Policy" hidden fields: scroll down — the field may exist but be scrolled out of view
