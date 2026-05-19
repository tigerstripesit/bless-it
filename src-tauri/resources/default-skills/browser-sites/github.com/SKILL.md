---
name: browser-sites/github.com
description: Browser automation guidance for GitHub — issue creation, PR review, code navigation, repository actions
disable-model-invocation: true
---

# GitHub — Browser Automation Guide

## DOM & ARIA Patterns

GitHub uses semantic HTML with `aria-label` and `data-component` as stable attributes. The site has two rendering modes: server-rendered pages and Turbo/Hotwire-driven navigation (no full reload between pages).

- Global search: `[aria-label="Search GitHub"]` or `[placeholder*="Search"]`
- New issue button: `[aria-label="New issue"]` or `a[href*="/issues/new"]`
- Issue title field: `[aria-label="Title"]` or `#issue_title`
- Issue body editor: `.markdown-body.js-blob-code` or `[aria-label="Comment body"]`
- Labels selector: `[aria-label="Labels"]` in the sidebar
- Assignees selector: `[aria-label="Assignees"]`
- Submit issue: `[aria-label="Submit new issue"]` or `button[type="submit"]` in the form
- PR review comment: `[aria-label="Leave a comment"]`
- Merge PR: `[aria-label="Merge pull request"]` or `[data-component="mergeButton"]`
- File tree: `[aria-label="File Tree"]`

## Standard Flows

### Create a new issue
1. `browser_navigate` → `https://github.com/{owner}/{repo}/issues/new`
   (or choose template: `/issues/new?template={name}.md`)
2. Fill `[aria-label="Title"]` or `#issue_title` with the issue title
3. Fill the description in the markdown editor (`[aria-label="Comment body"]`)
4. Set Labels, Assignees, Milestone from right sidebar
5. Click `[aria-label="Submit new issue"]`
6. After submission, URL changes to `.../issues/{number}` — extract issue number

### Search for an issue or PR
1. Navigate to `.../issues` or `.../pulls`
2. Use the search/filter bar (`[aria-label="Filter issues"]`)
3. Type query (e.g. `is:open label:bug`) — GitHub search syntax
4. Press Enter or click the result

### Comment on an issue or PR
1. Navigate to the issue/PR URL
2. Find the comment textarea: `[aria-label="Comment body"]` or `#new_comment_field`
3. Type the comment
4. Click "Comment" button (`[aria-label="Comment"]`)

### Close or reopen an issue
1. Navigate to the issue
2. Click "Close issue" (`[aria-label="Close issue"]`) or "Reopen issue"
3. Optionally add a comment before closing

### Review a PR (approve/request changes)
1. Navigate to `.../pull/{number}/files`
2. Click "Review changes" button
3. Select "Approve", "Comment", or "Request changes"
4. Add a comment if needed
5. Click "Submit review"

## Known Gotchas

- **Markdown editor**: GitHub uses CodeMirror for the issue/comment editor. `browser_act type` works with Playwright's `fill()` on the underlying textarea. Don't try to interact with the CodeMirror visual layer.
- **Turbo navigation**: GitHub uses Turbo for page transitions — the URL changes but there's no full page reload. The site profile sets `waitForIdle: false` since domcontentloaded is sufficient.
- **File inputs**: Some actions (uploading files, changing avatars) require file inputs — these cannot be automated without local file paths.
- **Rate limiting**: GitHub may require CAPTCHA or block actions if too many requests occur quickly — add pauses between bulk actions.
- **Organization permissions**: Some actions (merge PR, manage repo settings) require specific org/repo permissions for the logged-in user.
- **Draft PRs**: Draft PRs have a "Ready for review" button instead of a merge button.

## Failure Recovery

If the issue form doesn't load:
1. Check if user is logged in — the page may have redirected to sign-in
2. Try the direct URL with `/new?` parameters
3. GitHub sometimes shows a "template chooser" before the form — select "Open a blank issue" if a specific template isn't needed
