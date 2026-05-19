# LLM provider configuration

This app routes inference through one of five providers (Ollama, llama.cpp,
OpenAI-compatible, MLX, transformers.js). New in M1: the **browser-use**
harness, which requires a **vision-capable** model.

## Browser-use vision requirement

`browser_observe` returns a screenshot. Without vision, the model is blind to
the page. The harness only registers the four browser tools (`browser_open`,
`browser_navigate`, `browser_observe`, `browser_close`) when:

1. The `browserAgent` feature flag is on, **and**
2. The active model claims vision support.

For OpenAI-compatible presets this is a per-preset toggle (`supportsVision`
flag in Settings → Saved providers). For llama.cpp models it is inferred from
the model id (anything containing `vl`, `vision`, `llava`, or `moondream`).
All other providers are treated as non-vision in M1.

## Claude via the OpenAI-compatible provider

Claude can be reached through the existing OpenAI-compatible provider — no
native Anthropic client is shipped. Add a saved preset with:

| Field          | Value                                              |
|----------------|----------------------------------------------------|
| Name           | Claude (Anthropic)                                 |
| Endpoint       | `https://api.anthropic.com/v1`                     |
| API key        | Your Anthropic API key (`sk-ant-…`)                |
| Model name     | `claude-sonnet-4-6` or `claude-opus-4-7`           |
| Supports vision| **Yes**                                            |
| Context window | `200000`                                           |

Anthropic exposes an OpenAI-compatible `/chat/completions` endpoint that
accepts the same content blocks (`text` + `image_url`) and tool-call shape
that the rest of the app uses, so no provider-specific code is required.

Known limitations of the compat shim (flag for a future native Anthropic
provider — **not** implemented today):

- No `cache_control` markers (no prompt caching; the system + tool schema
  is re-paid every turn).
- No `anthropic-beta: computer-use-2025-01-24` header (so no Anthropic
  computer-use tool — Phase 2 work).
- No extended thinking, no server-side web search.

## Other recommended vision models

| Model                    | Provider          | Notes                                |
|--------------------------|-------------------|--------------------------------------|
| GPT-4o / GPT-4.1         | openai-compatible | Strong grounding; commercial usage.  |
| Qwen2.5-VL 7B / 3B       | llama.cpp / Ollama| Local; acceptable on simple flows.   |
| LLaVA-OneVision          | llama.cpp / Ollama| Local; good for screenshots.         |

For air-gapped tenants, prefer Qwen2.5-VL via llama.cpp — small enough to
ship and reliable on read-only `browser_observe` reasoning.

## Browser-use sidecar (dev)

The Playwright sidecar lives at `src-tauri/sidecar/browser/`. First-time
setup:

```bash
cd src-tauri/sidecar/browser
npm install
npx playwright install --with-deps chromium
npm run build
```

The Tauri host spawns `node dist/index.js` on first browser-tool call
(working directory: `src-tauri/`). Production binary packaging via Tauri
`externalBin` is M1.x follow-up work; the dev path runs fine without it.
