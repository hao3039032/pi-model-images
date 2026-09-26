# pi-model-images

Image-generation support for [pi](https://github.com/earendil-works/pi) coding agent.

## What it does

Models that generate images natively (responses `image_generation_call`, OpenRouter-style `delta.images`, data-URI emitters) ship image bytes in protocol fields that pi's stock parsers drop — you never see the picture. This extension fixes the whole pipeline **without adding providers or switching models**:

1. **Direct `imagegen` tool (codex-style)** — a protocol-independent tool that calls the OpenAI Images API directly (`POST {base}/images/generations` for new images, `POST {base}/images/edits` for edits), mirroring codex's `image_gen.imagegen` extension. It works with **any** model and provider — `openai-responses`, `openai-completions`, even `anthropic-messages` — because it never depends on the chat protocol. Supports:
   - text-to-image generation (`prompt`)
   - transparent backgrounds (`transparent_background`)
   - editing local images (`referenced_image_paths`, up to 5)
   - editing recent conversation images with no local path (`num_last_images_to_include`, up to 5 — scanned from user attachments, tool-shown images, and previously generated images, newest first)
2. **Same-name provider takeover** — every `models.json` provider speaking `openai-responses` or `openai-completions` is re-registered with an identical model list plus an image-aware stream wrapper:
   - responses: `image_generation_call` output items → message items carrying markdown
   - completions: `choices[].delta.images` (OpenRouter convention) → `delta.content` markdown
   - anthropic-messages providers are left untouched (no protocol image field); they are covered by the tool
3. **Generic data-URI catcher** — a `message_end` hook watches every assistant message regardless of provider; `data:image/...;base64` embedded in text is saved and rewritten to `file://` markdown.
4. **Inline display** — `imagegen` tool results carry `ImageContent` blocks that pi renders inline (kitty/iterm2 graphics protocols); stream-captured images are delivered as display-only custom messages rendered via pi-tui's `Image` component. The image bytes stay out of the text transcript.
5. **Context sanitizer** — outgoing requests replace `![image](file://…)` with `[image]` so upstream models never receive dead local links.

Images are saved to `~/.pi/images/` (content-addressed). Sessions render in both kitty/iterm2 terminals and [pi-agent-desktop](https://github.com/abcwyc/pi-agent-desktop) (whose web UI proxies `file://` markdown images through `/api/files`).

## Install

```bash
pi install git:github.com/hao3039032/pi-model-images
```

## imagegen tool configuration

The tool talks to the OpenAI Images API on its own, configured in its own dedicated config file `~/.pi/agent/pi-model-images.json` (the same convention as pi-plan-mode's `pi-plan-mode.json` and pi-web-access's `web-search.json`; the agent dir honors `PI_CODING_AGENT_DIR`):

```json
{
	"baseUrl": "https://api.openai.com/v1",
	"apiKey": "sk-...",
	"model": "gpt-image-2",
	"size": "auto",
	"quality": "auto"
}
```

| Field | Default | Description |
|---|---|---|
| `apiKey` | `OPENAI_API_KEY` env | API key (required). Supports pi's `$ENV_VAR` / `${ENV_VAR}` reference convention |
| `baseUrl` | `https://api.openai.com/v1` | Base URL of the Images API (any OpenAI-compatible gateway works) |
| `model` | `gpt-image-2` | Image model (matches codex's current default; use `gpt-image-1` for older deployments) |
| `size` | `auto` | `1024x1024` / `1536x1024` / `1024x1536` / `auto` |
| `quality` | `auto` | `low` / `medium` / `high` / `auto` |

Every field can be overridden per-invocation with environment variables: `PI_IMAGEGEN_API_KEY`, `PI_IMAGEGEN_BASE_URL`, `PI_IMAGEGEN_MODEL`, `PI_IMAGEGEN_SIZE`, `PI_IMAGEGEN_QUALITY` (env > config file > default; `apiKey` additionally falls back to `OPENAI_API_KEY`). The file is re-read on every tool call, so edits apply immediately.

Request shape follows codex: `{"prompt", "background": "opaque"|"transparent", "model", "quality", "size"}` against `/images/generations`, and the same plus `images: [{image_url: "data:..."}]` against `/images/edits`. The generated image is returned to the model as an image block (so it can reason about and iteratively edit it) plus a plain-text path hint; pi displays it inline automatically.

## Stream wrappers

The provider takeover delegates to pi-ai's built-in `openAIResponsesApi()` / `openAICompletionsApi()` with a wrapped `fetch`. The fetch pipes the SSE body through a `TransformStream` that rewrites image events in place:

- `response.output_item.done` with an `image_generation_call` item becomes a `message` item — pi-ai's parser lazily creates a text slot via `getOrCreateSlot`, so one rewritten event materializes the markdown with zero parser changes
- orphan `event:` lines are dropped together with their `data:` lines (an orphan breaks the OpenAI SDK parser)
- `response.completed`'s output array is rewritten too, so multi-MB base64 never flows through the SDK parser

Requires (for the stream-wrapper layer only): a provider entry in `~/.pi/agent/models.json` with `baseUrl` + `apiKey` + `models` and `api` set to `openai-responses` or `openai-completions` (e.g. [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI)). The `imagegen` tool itself works regardless.

## License

MIT
