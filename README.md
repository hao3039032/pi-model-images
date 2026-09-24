# pi-model-images

Transparent image-generation support for [pi](https://github.com/earendil-works/pi) coding agent.

## What it does

Models that generate images (Codex/GPT image tools, OpenRouter-style `delta.images`, data-URI emitters) ship image bytes in protocol fields that pi's stock parsers drop — you never see the picture. This extension fixes the whole pipeline **without adding providers or switching models**:

1. **Tool declaration** — for `openai-responses` providers, the built-in `image_generation` tool is declared on requests when absent (API-key deployments only expose image generation to requests that declare it). Injection is gated on model id: only models matching `gpt-*` (override via `PI_IMAGE_TOOL_MODELS`, comma-separated prefix globs) get the tool — the tool type is OpenAI-specific and would be rejected elsewhere.
2. **Same-name provider takeover** — every `models.json` provider speaking `openai-responses` or `openai-completions` is re-registered with an identical model list plus an image-aware stream wrapper:
   - responses: `image_generation_call` output items → message items carrying markdown
   - completions: `choices[].delta.images` (OpenRouter convention) → `delta.content` markdown
   - anthropic-messages providers are left untouched (no protocol image field)
2. **Generic data-URI catcher** — a `message_end` hook watches every assistant message regardless of provider; `data:image/...;base64` embedded in text is saved and rewritten to `file://` markdown.
3. **Inline display** — each image is also delivered as a display-only custom message rendered via pi-tui's `Image` component (kitty/iterm2 graphics protocols). The image bytes stay out of LLM context.
4. **Context sanitizer** — outgoing requests replace `![image](file://…)` with `[image]` so upstream models never receive dead local links.

Images are saved to `~/.pi/images/` (content-addressed). Sessions render in both kitty/iterm2 terminals and [pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop) (whose web UI proxies `file://` markdown images through `/api/files`).

## Install

```bash
pi install git:github.com/hao3039032/pi-model-images
```

Requires: a provider entry in `~/.pi/agent/models.json` with `baseUrl` + `apiKey` + `models` and `api` set to `openai-responses` or `openai-completions` (e.g. [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)).

## How it works

The stream wrapper delegates to pi-ai's built-in `openAIResponsesApi()` / `openAICompletionsApi()` with a wrapped `fetch`. The fetch pipes the SSE body through a `TransformStream` that rewrites image events in place:

- `response.output_item.done` with an `image_generation_call` item becomes a `message` item — pi-ai's parser lazily creates a text slot via `getOrCreateSlot`, so one rewritten event materializes the markdown with zero parser changes
- orphan `event:` lines are dropped together with their `data:` lines (an orphan breaks the OpenAI SDK parser)
- `response.completed`'s output array is rewritten too, so multi-MB base64 never flows through the SDK parser

## License

MIT
