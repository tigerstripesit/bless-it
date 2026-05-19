# IT Toolkit — Claude / Agent Context

## Stack

- **Tauri 2** (Rust) — backend, system APIs, file I/O, sidecar management
- **Next.js 15 / React 19** — frontend SPA (no SSR; Tauri WebView is the browser)
- **Fluent UI v9** (`@fluentui/react-components`) — design system, all UI components
- **TypeScript** throughout the frontend

---

## Critical: Fluent UI v9 + `createPortal`

**Problem:** Fluent UI v9 scopes its CSS variables (design tokens) to the `<FluentProvider>` DOM node, not to `:root`. Any React component rendered via `createPortal` to `document.body` lands **outside** that DOM node. The result:
- All Fluent UI components in the portal render unstyled (no border, no background, wrong colors)
- `Input`, `Select`, and similar form components are also non-interactive in this context

**Rule:** Every `createPortal(content, document.body)` call **must** wrap `content` in a `<FluentProvider>` using the active theme:

```tsx
import { FluentProvider, webLightTheme, webDarkTheme } from '@fluentui/react-components';
import { useTheme } from '@/lib/ThemeContext';

// inside the component:
const { theme: appTheme } = useTheme();
const fluentTheme = appTheme === 'light' ? webLightTheme : webDarkTheme;

return createPortal(
    <FluentProvider theme={fluentTheme}>{panel}</FluentProvider>,
    document.body,
);
```

The active theme comes from `src/lib/ThemeContext.tsx` via `useTheme()`. Default is `'dark'` (`webDarkTheme`).

> This was debugged in `WorkflowRunPanel.tsx`. The `Button` in the title bar appeared to work because Buttons are less visually dependent on token resolution; `Input` components had no visible border and were non-interactive until this fix was applied.

---

## Theme

- `src/lib/ThemeContext.tsx` — `ThemeProvider` wraps children in `FluentProvider`; exposes `useTheme()` hook
- `src/app/providers.tsx` — top-level `Providers` component, mounts `ThemeProvider`
- Default theme: **dark** (`webDarkTheme`)
- Persisted to `localStorage` under key `'app-theme'`

---

## Workflow System

### Schema versions
- **v1** — raw tool-call tape (legacy). Struct: `WorkflowFile` in `workflow_recorder.rs`.
- **v2** — intent-annotated, actor-aware, typed. Fields: `version: 2`, `variables`, typed `steps` with `intent`, `actor`, `retry`, `postcondition`. TypeScript type: `WorkflowFileV2`.

`workflow_load` returns `serde_json::Value` (raw JSON) to support both versions without a strict struct. The frontend uses the `isV2(wf)` guard in `src/types/workflow-types.ts` to dispatch.

### Actor model
| Actor | Meaning |
|-------|---------|
| `auto` | Deterministic, no LLM |
| `agent` | LLM fills from conversation context |
| `human` | Pauses for user interaction |

### Key files
| Path | Purpose |
|------|---------|
| `src-tauri/src/workflow_recorder.rs` | Tauri commands: record, list, load, replay bind, run checkpoints |
| `src/lib/workflows/engine.ts` | TypeScript execution loop, three-tier recovery |
| `src/lib/workflows/agent-recovery.ts` | LLM recovery sub-loop for failed steps |
| `src/components/WorkflowRunPanel.tsx` | Floating execution UI (portal — see FluentProvider note above) |
| `src/components/workflow/StepRow.tsx` | Per-step card with actor badge and retry state |
| `src/components/workflow/VariablesPanel.tsx` | Live variable display |
| `src/components/workflow/HumanGate.tsx` | Human input / intervention pause cards |
| `src/types/workflow-types.ts` | All workflow TypeScript types |
| `src-tauri/resources/default-workflows/` | Bundled canonical workflow JSON files |

### Workflow authoring rules

- Every workflow that uses browser steps **must** start with a `browser.open` step before any `browser.navigate` or `browser.act`. The sidecar requires an open session before any navigation. Missing this causes `"session X not open. Call browser.open first."` at runtime.
- Use `profile: "persistent"` for sites requiring login (Jira, Okta, M365, Slack) so the browser session remembers cookies across runs.
- Example first step:
  ```json
  {
    "id": "step-open-<site>",
    "intent": "Open a browser session for <site>",
    "tool": "browser.open",
    "params": { "session_id": "<site>", "profile": "persistent" },
    "actor": "auto",
    "classification": "read",
    "retry": { "maxAuto": 2, "escalateTo": "human" }
  }
  ```

### Seeding
Default workflows are seeded to `~/.ittoolkit/workflows/` on app startup (merge-only, never overwrites user edits). Same pattern as skills via `seed_default_workflows` in `workflow_recorder.rs`.

---

## Browser Automation

- **Sidecar**: `src-tauri/sidecar/browser/` — Playwright Node.js process managed by Tauri
- **Site profiles**: `src-tauri/sidecar/browser/src/site-profiles.ts` — per-hostname locator strategies, ready selectors, pre-act delays
- **Site skills**: `src-tauri/resources/default-skills/browser-sites/<hostname>/SKILL.md` — LLM knowledge injected on `browser_navigate`
- Profiled sites: Slack, GitHub, Linear, Figma, Notion, **M365 Admin**, **Okta Admin**, **Jira/Confluence**, **ServiceNow**

---

## Tauri / Rust Notes

- `AppHandle::path()` requires `use tauri::Manager;` in scope.
- New Tauri commands must be registered in `src-tauri/src/lib.rs` `invoke_handler!`.
- New resource directories must be added to `src-tauri/tauri.conf.json` under `bundle.resources`.
- `serde_json::Value` is used for schema-agnostic JSON passthrough when Rust structs would be too strict (e.g. `workflow_load`).
