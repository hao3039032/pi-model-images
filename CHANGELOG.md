# Changelog

## [0.3.0] - 2026-11-16

### Fixed

- **Provider-level compat survives the same-name takeover.** Layer 4 re-registers a `models.json` provider through `pi.registerProvider` so it can wrap image handling; pi builds an extension provider's models from the definitions the extension passed in and never re-applies the provider's own `compat`, so provider-level keys were silently dropped for every `openai-completions` / `openai-responses` provider. The victim was session affinity: `sendSessionAffinityHeaders` and `sessionAffinityFormat` stopped reaching the model, pi stopped sending `x-session-id`, and a router could no longer keep a session on the upstream that holds its prompt cache. Compat is now carried in `readWrapCandidates` and merged into each taken-over model (model-level wins, matching pi's own provider-then-model merge); the merge lives in `extensions/provider-compat.mjs` under regression coverage. `anthropic-messages` providers were never affected.
- Image edits are sent as `multipart/form-data` (`POST {base}/images/edits`), as the OpenAI Images API requires.

### Added

- `--output`/`-o` copies a generated image to a user-requested path; the canonical content-addressed copy stays in `~/.pi/images/`.
- `--n` requests several images from one generation (1-10); every returned image is saved and marked. Batch arrays of generation specs remain intentionally unsupported — run the CLI once per prompt.
- `--background transparent|opaque|auto` (shorthand `--transparent`) controls the image background, defaulting to `auto` to match codex; also configurable via `PI_IMAGEGEN_BACKGROUND` and the config file. The default model is now `gpt-image-2.5-sunburst`.
- Reference-image limit raised to the API's 16 (`--image` / `--last-images`).
- Generated images are tagged with `details.modelImages` for the desktop gallery.
- Codemode nested-call display, and review-loop fixes for the CLI + skill migration.
