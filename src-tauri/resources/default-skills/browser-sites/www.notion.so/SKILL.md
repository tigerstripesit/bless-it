---
name: browser-sites/www.notion.so
description: Browser automation guidance for Notion — page creation, database editing, block manipulation, search
disable-model-invocation: true
---

# Notion — Browser Automation Guide

## DOM & ARIA Patterns

Notion is a React SPA with a block-based editor. It has minimal stable test attributes — rely primarily on `aria-label` and role-based selectors.

- Sidebar: `.notion-sidebar` or `[data-sidebar="true"]`
- Page content area: `.notion-page-content` — readySelector
- Page title: `[placeholder="Untitled"]` or `[data-content-editable-leaf="true"]` at the top of the page
- Block editor: `.notion-selectable.notion-page-content div[contenteditable="true"]`
- Inline text blocks: `[data-block-id] div[contenteditable="true"]`
- Add new block (`/` command): type `/` in a text block to open the command palette
- Search: `[placeholder="Search"]` in the sidebar or `Ctrl+P` / `Cmd+P` keyboard shortcut
- Database "New" button: `[aria-label="New"]` or `.notion-database-view-footer button`
- Database cell: `[data-block-id] td` or `.notion-table-cell`

## Standard Flows

### Open a page
1. `browser_navigate` to the Notion workspace URL or page URL
2. Wait for `.notion-page-content`
3. Use the sidebar to navigate, or use `Ctrl+P` / `Cmd+P` for quick search
4. Type the page name and select from results

### Create a new page
1. In the sidebar, click `[aria-label="Add a page"]` or the `+` button next to a section
2. Observe — a new page opens with the title focused
3. Type the page title
4. Press Enter to move to the body
5. Start typing content, or use `/` to insert blocks

### Edit a text block
1. Find the block by its text content or `data-block-id`
2. Click on it to focus the contenteditable div
3. `browser_act type` to replace, or use click positioning to insert at a specific location
4. Click outside or Tab to move to next block

### Add a row to a database
1. Navigate to the database page
2. Click the "New" button at the bottom of the table or `[aria-label="New"]`
3. Fill in the inline row form, or the page that opens on the right
4. Press Escape or click outside to save the row

### Use the slash command palette
1. Click into a text block
2. Type `/`
3. Observe — command palette appears
4. Type the block type (e.g. "Heading 1", "To-do", "Table")
5. Click or press Enter to insert

## Known Gotchas

- **Contenteditable blocks**: Notion uses contenteditable divs, not `<textarea>`. Use `browser_act type` (which uses Playwright `fill()`) for simple replacement. For appending, click to position cursor, then `browser_act type`.
- **Block IDs change**: `data-block-id` UUIDs are stable in the URL but the DOM IDs may differ from the page ID — use content-based targeting when possible.
- **Virtual list**: Long pages use virtual rendering — blocks outside the viewport are not in the DOM. Scroll the page before observing to bring content into view.
- **Lazy loading**: Linked databases and large pages load incrementally. After `waitForIdle`, some content may still be loading — re-observe if elements are missing.
- **Slash commands require focus**: The `/` command palette only opens if a text block is focused. If no text block is focused, clicking elsewhere first before typing `/`.
- **Inline database properties**: Clicking a cell in a table opens an inline editor that's separate from the main page DOM — observe after clicking to get the editor context.

## Failure Recovery

If page content is not found:
1. The page may be loading lazily — wait and re-observe
2. Try `browser_mark` to see what's visible on screen
3. Scroll down — Notion's virtual rendering may not have loaded the target block
4. Use `Ctrl+P`/`Cmd+P` to search for and navigate to the target page directly
