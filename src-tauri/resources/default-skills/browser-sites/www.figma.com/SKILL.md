---
name: browser-sites/www.figma.com
description: Browser automation guidance for Figma — file navigation, comment creation, frame inspection, export
disable-model-invocation: true
---

# Figma — Browser Automation Guide

## DOM & ARIA Patterns

Figma's editor is a WebGL/canvas-based renderer with a thin HTML overlay for UI chrome. Most of the design canvas is NOT in the DOM — only the toolbar, panels, and comment threads are accessible via AX.

- Canvas container (readySelector): `[data-testid="canvas-container"]`
- Top toolbar: `[aria-label="Main menu"]`, `[data-testid="toolbar-section"]`
- Layers panel: `[aria-label="Layers"]` or `[data-testid="layers-panel"]`
- Pages list: `[data-testid="page-list"]`
- Page item: `[data-testid="page-tab"]`
- Comment mode button: `[aria-label="Add comment"]` or `[data-testid="toolbar-comment-icon"]`
- Comment text area: `[placeholder="Add a comment..."]`
- Export button: `[aria-label="Export"]`
- Prototype preview: `[aria-label="Present"]`
- File browser (home page): `[data-testid="file-browser"]`
- File cards: `[data-testid="file-card"]`

## Standard Flows

### Open a specific file
1. `browser_navigate` → `https://www.figma.com/file/{file_key}/{file_name}`
2. Wait for `[data-testid="canvas-container"]` (up to 20s)
3. Observe to confirm the file loaded — toolbar should be visible

### Navigate between pages
1. Find the pages list: `[data-testid="page-list"]`
2. Click the page tab with the desired name: `[data-testid="page-tab"]` matching the page name
3. Observe — canvas updates, URL changes to include `?node-id=`

### Add a comment
1. Click the comment tool: `[aria-label="Add comment"]` in the toolbar
2. Click on the canvas at the desired location (this is a click on the canvas container)
3. Observe — comment text area appears: `[placeholder="Add a comment..."]`
4. Type the comment
5. Press Enter or click the send button

### Inspect a layer's properties (developer handoff)
1. Switch to Dev Mode if available: `[aria-label="Dev Mode"]`
2. Click on the layer in the Layers panel: `[aria-label="Layers"]`
3. Right panel shows CSS/properties in HTML overlay

### Browse files from the home page
1. `browser_navigate` → `https://www.figma.com/files/`
2. Wait for `[data-testid="file-browser"]`
3. Find file cards `[data-testid="file-card"]` and click the target file

## Known Gotchas

- **Canvas is NOT in the DOM**: The actual design canvas is rendered via WebGL. You cannot read layer names, colors, or positions from the AX tree. Only the UI chrome (toolbar, panels, comments) is accessible.
- **Heavy load time**: Figma files can take 10–20s to load, especially large files with many components. The site profile waits up to 20s for `canvas-container`.
- **Limited AX elements**: `axMaxElements: 60` is set because the Layers panel can contain hundreds of items — only the top 60 are surfaced.
- **Canvas click coordinates**: To click on a specific layer in the canvas (not the Layers panel), you need absolute pixel coordinates — this is fragile and not recommended. Use the Layers panel to select layers instead.
- **Dev Mode gating**: Dev Mode requires a paid seat. If the Dev Mode button is absent, the user may not have access.
- **Prototype links**: Prototype preview URLs are separate (`/proto/...` path) from editor URLs (`/file/...`).

## Failure Recovery

If the canvas doesn't load:
1. The file may require a login or be in a private team — check if the user is authenticated
2. Refresh the page — Figma occasionally fails to load due to CDN issues
3. Use `browser_mark` to see what's visible; a "Loading" spinner or error modal may be present
4. If the file is very large, increase the wait time in your workflow step timeout

For finding a layer without the DOM:
1. Use Cmd+F (Find) to open Figma's built-in search — `[aria-label="Find and replace"]` or keyboard shortcut
2. Type the layer name — Figma highlights matching layers in the canvas
