---
name: imagegen
description: Generate images from text descriptions, or edit existing images based on specific instructions. Use it when the user requests an image based on a scene description (diagram, portrait, comic, meme, or any other visual), or wants to modify an attached or previously generated image (adding/removing elements, altering colors, improving quality/resolution, transforming style such as cartoon or oil painting).
---

# imagegen — image generation & editing CLI

This skill bundles a zero-dependency Node CLI (`scripts/imagegen.mjs`) that calls the OpenAI Images API directly. It works with any model/provider because it never depends on the chat protocol.

## When to use

Use this CLI whenever the user asks to create or edit an image (drawing, diagram, portrait, comic, meme, photo, style change, transparent background/cutout). Do not use other tools for image editing unless the user explicitly requests it.

## Invocation

Resolve the script path against this skill's directory (the parent of this `SKILL.md`), then run it with node:

```bash
node <skill-dir>/scripts/imagegen.mjs --prompt "A watercolor painting of a mountain lake at dawn"
```

Generate a brand-new image (omit `--image`/`--last-images` entirely):

```bash
node <skill-dir>/scripts/imagegen.mjs --prompt "..." [--transparent]
```

Edit local images — pass up to 5 paths when every target image has a local path:

```bash
node <skill-dir>/scripts/imagegen.mjs --prompt "make the sky sunset-colored" --image /abs/path/a.png --image /abs/path/b.png
```

Edit recent conversation images — only when a target image has no local file path. `N` is the smallest number of recent images (1-5) covering every target; relative paths resolve against the current working directory:

```bash
node <skill-dir>/scripts/imagegen.mjs --prompt "remove the background clutter" --last-images 1
```

## Flags

| Flag | Description |
|---|---|
| `--prompt <text>` | Required. Description of the desired image, or the edit instructions. |
| `--transparent` | Transparent background (default opaque). Use only for transparency/cutout/background-removal requests; for edits preserve existing transparency unless asked. |
| `--image <path>` | Repeatable, up to 5. Local image paths to edit. |
| `--last-images <N>` | 1-5. Use the last N images from the current pi session (works inside pi's shell via `PI_SESSION_FILE`). |
| `--model/--size/--quality` | One-off overrides; defaults come from config. |
| `--timeout <sec>` | Request timeout (default 300). |

Never provide both `--image` and `--last-images`. If neither mechanism can include every target image, ask the user to attach the missing images again, then generate directly without reconfirmation.

## Configuration

Read from `~/.pi/agent/pi-model-images.json` (`baseUrl` / `apiKey` / `model` / `size` / `quality`), overridable via `PI_IMAGEGEN_*` env vars (`apiKey` falls back to `OPENAI_API_KEY`). If the CLI reports a missing API key, tell the user to set `apiKey` in that file.

## Output & behavior

- Generation can take a few minutes — run it once with an adequate shell-tool timeout (e.g. 360 seconds) and wait; avoid duplicate parallel calls for the same image.
- On success stdout ends with one `PI_IMAGEGEN_FILE <path>` marker line per image. The pi-model-images extension automatically injects those images into the conversation (inline display) — **do not re-render the image in your response as Markdown or a file link**; mentioning the plain path is fine. If that extension is not active, embed `![image](file://<path>)` instead.
- If you need a generated image at another path, copy it and leave the original in place unless the user explicitly asks you to delete it.
- On failure the CLI exits non-zero with an `imagegen: ...` message on stderr; report it to the user.
