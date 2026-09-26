/**
 * model-images: transparent image-generation support for pi.
 *
 * No new providers, no model switching. This extension:
 *
 * 1. Direct `imagegen` tool (codex-style) — a protocol-independent tool that
 *    calls the OpenAI Images API directly (POST {base}/images/generations,
 *    /images/edits as JSON), so ANY model — including anthropic-messages and
 *    completions-only ones — can generate and edit images. Configured via
 *    ~/.pi/agent/pi-model-images.json (baseUrl / apiKey / model / size /
 *    quality; default base URL is the official https://api.openai.com/v1)
 *    with PI_IMAGEGEN_* env overrides.
 *
 * 2. Same-name takeover — every models.json provider speaking
 *    `openai-responses` or `openai-completions` is re-registered with an
 *    identical model list plus an image-aware stream wrapper:
 *      - responses: rewrites `image_generation_call` output items (which the
 *        stock parser drops) into message items carrying file:// markdown
 *      - completions: rewrites `choices[].delta.images` (OpenRouter
 *        convention, also dropped by the stock parser) into delta.content
 *    anthropic-messages providers are left untouched (no protocol image
 *    field); they are covered by the tool and layer 3.
 *
 * 3. Generic data-URI catcher — a `message_end` hook watches every assistant
 *    message regardless of provider; data:image URIs embedded in text are
 *    saved to disk and rewritten to file:// markdown.
 *
 * 4. Display — tool results carry ImageContent blocks that pi renders inline
 *    (kitty/iterm2 graphics protocols); stream-captured images are delivered
 *    as display-only custom messages rendered through the pi-tui Image
 *    component. `details` stays out of LLM context.
 *
 * Outgoing context is sanitized (`context` hook + onPayload on wrapped
 * providers): `![image](file://…)` becomes `[image]` so upstream models never
 * receive dead local links.
 *
 * Images live in ~/.pi/images/ (content-addressed). Works alongside
 * pi-agent-desktop, whose web UI renders the file:// markdown via its
 * /api/files proxy (session-referenced paths are allowed).
 */

import {
	openAICompletionsApi,
	openAIResponsesApi,
	createAssistantMessageEventStream,
	type AssistantMessageEventStream,
	type Model,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Image } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const IMG_DIR = path.join(os.homedir(), ".pi", "images");
const IMG_MARKDOWN = /!\[image\]\(file:\/\/[^)]*\.pi\/images\/[^)]+\)/g;
const DATA_URI_IMAGE = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\)/g;
const BARE_DATA_URI = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/g;

interface ImageDetails {
	data: string;
	mimeType: string;
	filePath: string;
}

interface SavedImage {
	filePath: string;
	markdown: string;
	details: ImageDetails;
}

/** Filled by the factory; decouples SSE rewrite paths from the ExtensionAPI. */
let notifyImage: ((details: ImageDetails) => void) | undefined;

// =============================================================================
// Image persistence
// =============================================================================

function saveBase64(b64: string, mimeType: string): SavedImage {
	const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : mimeType === "image/gif" ? "gif" : "png";
	const name = `${crypto.createHash("sha1").update(b64).digest("hex").slice(0, 16)}.${ext}`;
	fs.mkdirSync(IMG_DIR, { recursive: true });
	const filePath = path.join(IMG_DIR, name);
	fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
	return { filePath, markdown: `![image](file://${filePath})`, details: { data: b64, mimeType, filePath } };
}

function mimeFromOutputFormat(format: string): string {
	switch (format.toLowerCase()) {
		case "jpeg":
		case "jpg":
			return "image/jpeg";
		case "webp":
			return "image/webp";
		case "gif":
			return "image/gif";
		default:
			return "image/png";
	}
}

function saveDataUrl(url: string): SavedImage | null {
	const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
	if (!m) return null;
	return saveBase64(m[2], m[1]);
}

// =============================================================================
// Direct imagegen tool (codex-style) — protocol-independent image generation
// =============================================================================

/**
 * Mirrors codex's `image_gen.imagegen` extension: a plain tool that talks to
 * the OpenAI Images API directly — POST {base}/images/generations for new
 * images and POST {base}/images/edits (JSON body with data-URL images) for
 * edits — independent of the chat/responses protocol of the active provider.
 *
 * Configuration lives in its own file `~/.pi/agent/pi-model-images.json`
 * (dedicated per-package config file, same convention as pi-plan-mode's
 * pi-plan-mode.json / pi-web-access's web-search.json; the agent dir honors
 * PI_CODING_AGENT_DIR):
 *
 *   {
 *     "baseUrl": "https://api.openai.com/v1",
 *     "apiKey": "sk-...",        // or "$MY_KEY" / "${MY_KEY}" env reference
 *     "model": "gpt-image-2",
 *     "size": "auto",             // 1024x1024 | 1536x1024 | 1024x1536 | auto
 *     "quality": "auto"           // low | medium | high | auto
 *   }
 *
 * Every field may instead be set via environment variable (overrides the
 * file): PI_IMAGEGEN_BASE_URL, PI_IMAGEGEN_API_KEY (falls back to
 * OPENAI_API_KEY), PI_IMAGEGEN_MODEL, PI_IMAGEGEN_SIZE, PI_IMAGEGEN_QUALITY.
 */

const IMAGEGEN_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const IMAGEGEN_DEFAULT_MODEL = "gpt-image-2";
const MAX_EDIT_IMAGES = 5;
const FILE_URI_IMAGE_GLOBAL = /!\[[^\]]*\]\(file:\/\/(\/[^)\s]+)\)/g;

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

interface ImagegenParams {
	prompt: string;
	transparent_background?: boolean;
	referenced_image_paths?: string[];
	num_last_images_to_include?: number;
}

const IMAGEGEN_PARAMS = Type.Object({
	prompt: Type.String({
		description:
			"A text description of the desired image, or the edit instructions to apply to the referenced images. Include subject, style, composition, colors, and any text to render.",
	}),
	transparent_background: Type.Optional(
		Type.Boolean({ description: "Whether the output should have a transparent background. Defaults to false." }),
	),
	referenced_image_paths: Type.Optional(
		Type.Array(Type.String(), {
			maxItems: MAX_EDIT_IMAGES,
			description: `Local file paths of up to ${MAX_EDIT_IMAGES} images to edit. Omit when generating a brand new image.`,
		}),
	),
	num_last_images_to_include: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: MAX_EDIT_IMAGES,
			description:
				"Include the last N images from the conversation (user attachments, images shown by tools, or previously generated images) as edit inputs. Use only when a target image has no local file path.",
		}),
	),
});

const IMAGEGEN_CONFIG_FILENAME = "pi-model-images.json";

interface ImagegenSettings {
	baseUrl?: unknown;
	apiKey?: unknown;
	model?: unknown;
	size?: unknown;
	quality?: unknown;
}

function getImagegenConfigPath(): string {
	return path.join(getAgentDir(), IMAGEGEN_CONFIG_FILENAME);
}

function readImagegenSettings(): ImagegenSettings {
	try {
		const parsed = JSON.parse(fs.readFileSync(getImagegenConfigPath(), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ImagegenSettings) : {};
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
			console.error(`model-images: failed to read ${IMAGEGEN_CONFIG_FILENAME} — ${err instanceof Error ? err.message : String(err)}`);
		}
		return {};
	}
}

/** Resolves pi's `$VAR` / "${VAR}" apiKey env-reference convention. */
function resolveEnvRef(value: string): string {
	const m = /^\$\{([^}]+)\}$/.exec(value) ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
	return m ? (process.env[m[1]] ?? "") : value;
}

function imagegenConfig() {
	const settings = readImagegenSettings();
	const str = (envVar: string, key: keyof ImagegenSettings, fallback: string): string => {
		const fromSettings = settings[key];
		const fromEnv = process.env[envVar];
		const value = fromEnv ?? (typeof fromSettings === "string" && fromSettings.trim() ? fromSettings : undefined);
		return (value ?? fallback).trim();
	};
	const baseUrl = str("PI_IMAGEGEN_BASE_URL", "baseUrl", IMAGEGEN_DEFAULT_BASE_URL).replace(/\/+$/, "");
	const model = str("PI_IMAGEGEN_MODEL", "model", IMAGEGEN_DEFAULT_MODEL);
	const size = str("PI_IMAGEGEN_SIZE", "size", "auto");
	const quality = str("PI_IMAGEGEN_QUALITY", "quality", "auto");
	const apiKey = (
		process.env.PI_IMAGEGEN_API_KEY ||
		(typeof settings.apiKey === "string" ? resolveEnvRef(settings.apiKey.trim()) : "") ||
		process.env.OPENAI_API_KEY ||
		""
	).trim();
	return { baseUrl, apiKey, model, size, quality };
}

function mimeFromFilePath(filePath: string): string | undefined {
	return MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

function readImageDataUrl(rawPath: string, cwd: string): string {
	const filePath = path.resolve(cwd, rawPath.trim());
	const mimeType = mimeFromFilePath(filePath);
	if (!mimeType) {
		throw new Error(`imagegen: unsupported image type for \`${filePath}\` (expected png/jpg/webp/gif)`);
	}
	let bytes: Buffer;
	try {
		bytes = fs.readFileSync(filePath);
	} catch (err) {
		throw new Error(`imagegen: unable to read referenced image \`${filePath}\` — ${err instanceof Error ? err.message : String(err)}`);
	}
	return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

/**
 * Newest-first scan of the session branch for conversation images — image
 * blocks in user/toolResult messages plus file:// markdown saved by this
 * extension (restricted to IMG_DIR). Mirrors codex `recent_images`.
 */
function collectRecentImages(count: number, ctx: { sessionManager: { getBranch(): unknown[] } }): Array<{ data: string; mimeType: string }> {
	const collected: Array<{ data: string; mimeType: string }> = [];
	const seen = new Set<string>();
	const push = (data: string, mimeType: string) => {
		if (!data || seen.has(data)) return;
		seen.add(data);
		collected.push({ data, mimeType });
	};
	let entries: unknown[] = [];
	try {
		entries = ctx.sessionManager.getBranch() ?? [];
	} catch {
		entries = [];
	}
	for (let i = entries.length - 1; i >= 0 && collected.length < count; i--) {
		const entry = entries[i] as { type?: string; message?: { role?: string; content?: unknown } } | undefined;
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "user" && message?.role !== "assistant" && message?.role !== "toolResult") continue;
		const blocks = Array.isArray(message?.content) ? (message.content as Array<Record<string, unknown>>) : [];
		for (let j = blocks.length - 1; j >= 0 && collected.length < count; j--) {
			const block = blocks[j];
			if (block?.type === "image" && typeof block.data === "string") {
				push(block.data, typeof block.mimeType === "string" ? block.mimeType : "image/png");
			} else if (block?.type === "text" && typeof block.text === "string" && block.text.includes("](file://")) {
				const matches = [...block.text.matchAll(FILE_URI_IMAGE_GLOBAL)];
				for (let k = matches.length - 1; k >= 0 && collected.length < count; k--) {
					const filePath = matches[k][1];
					if (!filePath.startsWith(IMG_DIR + path.sep)) continue; // only extension-saved images
					const mimeType = mimeFromFilePath(filePath);
					if (!mimeType) continue;
					try {
						push(fs.readFileSync(filePath).toString("base64"), mimeType);
					} catch {
						// best effort — skip unreadable files
					}
				}
			}
		}
	}
	if (collected.length !== count) {
		throw new Error(`imagegen: requested the last ${count} conversation images, but only ${collected.length} were available`);
	}
	collected.reverse(); // oldest-first input order, matching codex
	return collected;
}

async function callImagesApi(
	cfg: { baseUrl: string; apiKey: string },
	endpoint: string,
	body: Record<string, unknown>,
	signal: AbortSignal | undefined,
): Promise<Record<string, any>> {
	let response: Response;
	try {
		response = await fetch(`${cfg.baseUrl}${endpoint}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		if (signal?.aborted) throw new Error("imagegen: aborted");
		throw new Error(`imagegen: request failed — ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!response.ok) {
		let message = `HTTP ${response.status}`;
		try {
			const text = await response.text();
			try {
				const parsed = JSON.parse(text);
				message += ` — ${String(parsed?.error?.message ?? text).slice(0, 500)}`;
			} catch {
				if (text) message += ` — ${text.slice(0, 500)}`;
			}
		} catch {
			// status-only error
		}
		throw new Error(`imagegen: image request failed (${message})`);
	}
	let json: Record<string, any>;
	try {
		json = (await response.json()) as Record<string, any>;
	} catch (err) {
		throw new Error(`imagegen: failed to decode response — ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!Array.isArray(json?.data) || json.data.length === 0) {
		throw new Error("imagegen: response contained no image data");
	}
	return json;
}

async function extractImageDatum(item: unknown, fallbackMime: string, signal: AbortSignal | undefined): Promise<{ data: string; mimeType: string }> {
	const record = item as { b64_json?: unknown; url?: unknown } | undefined;
	if (typeof record?.b64_json === "string" && record.b64_json) {
		return { data: record.b64_json, mimeType: fallbackMime };
	}
	const url = typeof record?.url === "string" ? record.url : "";
	if (url.startsWith("data:")) {
		const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
		if (!m) throw new Error("imagegen: malformed data: URL in response");
		return { data: m[2], mimeType: m[1] };
	}
	if (/^https?:\/+\//.test(url)) {
		const response = await fetch(url, { signal });
		if (!response.ok) throw new Error(`imagegen: failed to download generated image (HTTP ${response.status})`);
		const mimeType = response.headers.get("content-type")?.split(";")[0] || fallbackMime;
		const data = Buffer.from(await response.arrayBuffer()).toString("base64");
		return { data, mimeType: mimeType.startsWith("image/") ? mimeType : fallbackMime };
	}
	throw new Error("imagegen: response contained neither b64_json nor url image data");
}

function registerImagegenTool(pi: ExtensionAPI) {
	pi.registerTool({
		name: "imagegen",
		label: "Image Generation",
		description:
			"Generate images from text descriptions, or edit existing images based on specific instructions. Use it when the user requests an image based on a scene description (diagram, portrait, comic, meme, or any other visual), or wants to modify an attached or previously generated image (adding/removing elements, altering colors, improving quality/resolution, transforming style such as cartoon or oil painting).",
		promptSnippet: "Generate images from descriptions, or edit attached/previously generated images (imagegen).",
		promptGuidelines: [
			"Use imagegen whenever the user asks to create or edit an image (drawing, diagram, portrait, comic, meme, photo, style change); do not use other tools for image editing unless the user explicitly requests it.",
			"imagegen can take a few minutes — issue the call and wait; avoid duplicate parallel calls for the same image.",
			"Set transparent_background true only when the request calls for a transparent background, background removal, or a cutout; for edits, preserve existing transparency unless the user asks to change it.",
			"Omit both referenced_image_paths and num_last_images_to_include when generating a brand new image.",
			"For edits, pass local file paths via referenced_image_paths (up to 5) when every target image has a local path; use num_last_images_to_include (the smallest number of recent conversation images covering every target, up to 5) only when a target image has no local path; never provide both.",
			"If neither mechanism can include every target image, ask the user to attach the missing images again, then generate directly without reconfirmation.",
			"The generated image is already displayed to the user automatically; do not render it again as a Markdown image or file link in your response.",
		],
		parameters: IMAGEGEN_PARAMS,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const cfg = imagegenConfig();
			if (!cfg.apiKey) {
				throw new Error(
					`imagegen: no API key configured — set apiKey in ~/.pi/agent/${IMAGEGEN_CONFIG_FILENAME} (or PI_IMAGEGEN_API_KEY / OPENAI_API_KEY)`,
				);
			}
			const args = params as ImagegenParams;
			if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("imagegen: prompt is required");
			const background = args.transparent_background ? "transparent" : "opaque";
			const base = { prompt: args.prompt, background, model: cfg.model, quality: cfg.quality, size: cfg.size };

			const paths = (args.referenced_image_paths ?? []).filter((p) => typeof p === "string" && p.trim());
			const includeLast = args.num_last_images_to_include;
			if (paths.length > 0 && includeLast != null) {
				throw new Error("imagegen: provide only one of referenced_image_paths or num_last_images_to_include");
			}
			if (paths.length > MAX_EDIT_IMAGES) {
				throw new Error(`imagegen: referenced_image_paths must contain at most ${MAX_EDIT_IMAGES} paths`);
			}

			let endpoint = "/images/generations";
			let body: Record<string, unknown> = { ...base };
			if (paths.length > 0) {
				const cwd = ctx.sessionManager.getCwd();
				endpoint = "/images/edits";
				body = { ...base, images: paths.map((p) => ({ image_url: readImageDataUrl(p, cwd) })) };
			} else if (includeLast != null) {
				endpoint = "/images/edits";
				body = {
					...base,
					images: collectRecentImages(includeLast, ctx).map((img) => ({ image_url: `data:${img.mimeType};base64,${img.data}` })),
				};
			}

			const json = await callImagesApi(cfg, endpoint, body, signal);
			const fallbackMime = mimeFromOutputFormat(typeof json?.output_format === "string" ? json.output_format : "png");
			const saved: SavedImage[] = [];
			for (const item of json.data) {
				const { data, mimeType } = await extractImageDatum(item, fallbackMime, signal);
				saved.push(saveBase64(data, mimeType));
			}

			const savedList = saved.length === 1 ? saved[0].filePath : saved.map((s) => `- ${s.filePath}`).join("\n");
			const hint = [
				`Generated image${saved.length > 1 ? "s" : ""} saved to ${saved.length > 1 ? `:\n${savedList}` : `${savedList}.`}`,
				"If you need to use a generated image at another path, copy it and leave the original in place unless the user explicitly asks you to delete it.",
				"The generated image is already displayed to the user. There is no need to render it in the final response as a Markdown image or file link.",
			].join("\n");

			return {
				content: [
					...saved.map((s) => ({ type: "image" as const, data: s.details.data, mimeType: s.details.mimeType })),
					{ type: "text" as const, text: hint },
				],
				details: { model: cfg.model, prompt: args.prompt, background, filePaths: saved.map((s) => s.filePath) },
			};
		},
	});
}

// =============================================================================
// Responses-protocol SSE rewriter
// =============================================================================

/**
 * Parser mechanics (pi-ai openai-responses-shared.js) that make this work:
 * - output_item.added for image items creates no slot (ignored) — fine.
 * - output_item.done goes through getOrCreateSlot: a rewritten message item
 *   lazily creates a text slot, sets its text from item.content, and emits
 *   text_start/text_end events.
 * - response.completed's output array is rewritten too, so multi-MB base64
 *   never flows through the SDK parser.
 */
function makeResponsesImageFetch(baseFetch: typeof globalThis.fetch): typeof globalThis.fetch {
	const encoder = new TextEncoder();

	const imageItemToMessage = (item: Record<string, any>): Record<string, any> => {
		const b64 = typeof item.result === "string" ? item.result : "";
		const id = item.id ?? `img_${crypto.randomBytes(6).toString("hex")}`;
		if (!b64) {
			return { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text: "\n[image: upstream returned empty result]" }] };
		}
		let saved: SavedImage;
		try {
			saved = saveBase64(b64, mimeFromOutputFormat(item.output_format ?? "png"));
		} catch (err) {
			return { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text: `\n[image: save failed — ${err instanceof Error ? err.message : String(err)}]` }] };
		}
		notifyImage?.(saved.details);
		return { type: "message", id, role: "assistant", status: "completed", content: [{ type: "output_text", text: `\n${saved.markdown}` }] };
	};

	const rewriteData = (raw: string): string | null => {
		let event: any;
		try {
			event = JSON.parse(raw);
		} catch {
			return raw; // e.g. "[DONE]" or non-JSON — pass through
		}
		if (event?.type === "response.output_item.done" && event.item?.type === "image_generation_call") {
			event.item = imageItemToMessage(event.item);
			return JSON.stringify(event);
		}
		if (event?.type === "response.completed" && Array.isArray(event.response?.output)) {
			let changed = false;
			for (let i = 0; i < event.response.output.length; i++) {
				const out = event.response.output[i];
				if (out?.type === "image_generation_call") {
					event.response.output[i] = imageItemToMessage(out);
					changed = true;
				}
			}
			return changed ? JSON.stringify(event) : raw;
		}
		if (typeof event?.type === "string" && event.type.startsWith("response.image_generation_call.")) {
			return null; // in_progress / generating / partial_image noise
		}
		return raw;
	};

	return async function responsesImageFetch(input, init) {
		const response = await (baseFetch ?? globalThis.fetch)(input, init);
		const ct = response.headers?.get?.("content-type") ?? "";
		if (!ct.includes("text/event-stream") || !response.body) return response;

		const decoder = new TextDecoder();
		let buffer = "";
		let skipNextDataLine = false;
		const transformed = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					// SSE pairs "event:" with the following "data:" line; an
					// orphan event line breaks the SDK parser, so drop both.
					if (line.startsWith("event: response.image_generation_call.")) {
						skipNextDataLine = true;
						continue;
					}
					if (line.startsWith("data: ")) {
						if (skipNextDataLine) {
							skipNextDataLine = false;
							continue;
						}
						const rewritten = rewriteData(line.slice(6));
						if (rewritten === null) continue;
						controller.enqueue(encoder.encode(`data: ${rewritten}\n`));
						continue;
					}
					controller.enqueue(encoder.encode(`${line}\n`));
				}
			},
		});
		return new Response(response.body.pipeThrough(transformed), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}

// =============================================================================
// Completions-protocol SSE rewriter (OpenRouter delta.images convention)
// =============================================================================

function makeCompletionsImageFetch(baseFetch: typeof globalThis.fetch): typeof globalThis.fetch {
	const encoder = new TextEncoder();

	const rewriteChunk = (raw: string): string => {
		let chunk: any;
		try {
			chunk = JSON.parse(raw);
		} catch {
			return raw; // "[DONE]" etc.
		}
		const choice = chunk?.choices?.[0];
		const container = choice?.delta ?? choice?.message;
		const images = container?.images;
		if (!Array.isArray(images) || images.length === 0) return raw;

		let markdown = "";
		for (const img of images) {
			const url = typeof img?.image_url === "string" ? img.image_url : img?.image_url?.url;
			if (!url) continue;
			const saved = saveDataUrl(url);
			if (!saved) continue;
			markdown += `\n${saved.markdown}`;
			notifyImage?.(saved.details);
		}
		delete container.images;
		if (markdown) {
			container.content = typeof container.content === "string" ? container.content + markdown : markdown;
		}
		return JSON.stringify(chunk);
	};

	return async function completionsImageFetch(input, init) {
		const response = await (baseFetch ?? globalThis.fetch)(input, init);
		const ct = response.headers?.get?.("content-type") ?? "";
		if (!ct.includes("text/event-stream") || !response.body) return response;

		const decoder = new TextDecoder();
		let buffer = "";
		const transformed = new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				let newline: number;
				while ((newline = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, newline);
					buffer = buffer.slice(newline + 1);
					if (line.startsWith("data: ")) {
						controller.enqueue(encoder.encode(`data: ${rewriteChunk(line.slice(6))}\n`));
						continue;
					}
					controller.enqueue(encoder.encode(`${line}\n`));
				}
			},
		});
		return new Response(response.body.pipeThrough(transformed), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}

// =============================================================================
// Outgoing-context sanitization
// =============================================================================

function stripImageMarkdownFromPayload(payload: unknown): unknown {
	if (payload == null || typeof payload !== "object") return payload;
	const body = payload as { input?: Array<Record<string, any>>; messages?: Array<Record<string, any>> };
	const containers = [...(Array.isArray(body.input) ? body.input : []), ...(Array.isArray(body.messages) ? body.messages : [])];
	for (const item of containers) {
		if (item?.type === "message" && item.role === "assistant" && Array.isArray(item.content)) {
			for (const part of item.content) {
				if (typeof part?.text === "string" && part.text.includes("](file://")) {
					part.text = part.text.replace(IMG_MARKDOWN, "[image]");
				}
			}
		} else if (item?.role === "assistant") {
			if (typeof item.content === "string" && item.content.includes("](file://")) {
				item.content = item.content.replace(IMG_MARKDOWN, "[image]");
			} else if (Array.isArray(item.content)) {
				for (const part of item.content) {
					const text = typeof part?.text === "string" ? part.text : undefined;
					if (text?.includes("](file://")) part.text = text.replace(IMG_MARKDOWN, "[image]");
				}
			}
		}
	}
	return payload;
}

// =============================================================================
// Extension entry
// =============================================================================

interface ProviderCfg {
	baseUrl: string;
	apiKey: string;
	api: string;
	models: Array<Record<string, any>>;
}

function readWrapCandidates(): Map<string, ProviderCfg> {
	const file = path.join(os.homedir(), ".pi", "agent", "models.json");
	const json = JSON.parse(fs.readFileSync(file, "utf8"));
	const out = new Map<string, ProviderCfg>();
	for (const [name, cfg] of Object.entries(json?.providers ?? {})) {
		const c = cfg as Record<string, any>;
		if (!c?.baseUrl || !c?.apiKey || !Array.isArray(c?.models)) continue;
		if (c.api !== "openai-responses" && c.api !== "openai-completions") continue;
		out.set(name, { baseUrl: c.baseUrl, apiKey: c.apiKey, api: c.api, models: c.models });
	}
	return out;
}

export default function modelImagesExtension(pi: ExtensionAPI) {
	// ---- Layer 1: direct imagegen tool (works with every provider) ----
	registerImagegenTool(pi);

	// ---- Display layer: inline pixels via custom message + Image component ----
	pi.registerMessageRenderer<ImageDetails>("model-image", (message, _options, theme) => {
		const details = message.details;
		if (!details?.data || !details.mimeType) return undefined;
		return new Image(details.data, details.mimeType, { fallbackColor: (s) => theme.fg("toolOutput", s) }) as unknown as Component;
	});

	const notifiedHashes = new Set<string>();
	notifyImage = (details) => {
		try {
			const hash = crypto.createHash("sha1").update(details.data).digest("hex").slice(0, 16);
			if (notifiedHashes.has(hash)) return; // dedupe across completed+done
			notifiedHashes.add(hash);
			pi.sendMessage(
				{ customType: "model-image", content: `[image generated: ${details.filePath}]`, display: true, details },
				{ triggerTurn: false },
			);
		} catch {
			// Display-only enhancement; never fail the stream.
		}
	};

	// ---- Layer 3: generic data-URI catcher for every provider ----
	pi.on("message_end", (event) => {
		const message = (event as any)?.message;
		if (message?.role !== "assistant" || !Array.isArray(message.content)) return;
		let changed = false;
		const content = message.content.map((block: any) => {
			if (block?.type !== "text" || typeof block.text !== "string") return block;
			if (!block.text.includes("data:image/")) return block; // fast path
			let text = block.text;
			text = text.replace(DATA_URI_IMAGE, (_m: string, alt: string, uri: string) => {
				const saved = saveDataUrl(uri);
				if (!saved) return _m;
				changed = true;
				notifyImage?.(saved.details);
				return `![${alt || "image"}](${saved.filePath.startsWith("/") ? `file://${saved.filePath}` : saved.filePath})`;
			});
			text = text.replace(BARE_DATA_URI, (uri: string) => {
				const saved = saveDataUrl(uri);
				if (!saved) return uri;
				changed = true;
				notifyImage?.(saved.details);
				return saved.markdown;
			});
			return changed && text !== block.text ? { ...block, text } : block;
		});
		if (!changed) return;
		return { message: { ...message, content } };
	});

	// ---- Outgoing-context sanitizer (covers non-wrapped providers) ----
	pi.on("context" as any, (event: any) => {
		for (const message of event?.messages ?? []) {
			if (message?.role !== "assistant" || !Array.isArray(message.content)) continue;
			for (const block of message.content) {
				if (block?.type === "text" && typeof block.text === "string" && block.text.includes("](file://")) {
					block.text = block.text.replace(IMG_MARKDOWN, "[image]");
				}
			}
		}
	});

	// ---- Layer 4: same-name takeover of models.json providers ----
	let candidates: Map<string, ProviderCfg>;
	try {
		candidates = readWrapCandidates();
	} catch (err) {
		console.error(`model-images: failed to read models.json — ${err instanceof Error ? err.message : String(err)}`);
		return;
	}

	for (const [name, cfg] of candidates) {
		const models = cfg.models.map((m) => ({
			...m,
			// registerProvider passes models through without defaulting cost;
			// downstream cost merge reads model.cost.tiers and crashes without it.
			cost: m.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		})) as ProviderModelConfig[];

		const isResponses = cfg.api === "openai-responses";
		const imageFetch = isResponses ? makeResponsesImageFetch(globalThis.fetch) : makeCompletionsImageFetch(globalThis.fetch);
		const innerApi = isResponses ? openAIResponsesApi() : openAICompletionsApi();
		const onPayload = (payload: unknown) => stripImageMarkdownFromPayload(payload);

		const streamSimple = (
			model: Model<any>,
			context: TranscriptContext,
			options?: SimpleStreamOptions,
		): AssistantMessageEventStream => {
			const out = createAssistantMessageEventStream();
			(async () => {
				const inner = (innerApi as any).streamSimple({ ...model, baseUrl: cfg.baseUrl }, context, {
					...options,
					apiKey: cfg.apiKey,
					fetch: imageFetch,
					onPayload,
				});
				for await (const event of inner) out.push(event);
				out.end();
			})().catch(() => {
				out.end();
			});
			return out;
		};

		// Same-name registration replaces the models.json-driven behavior while
		// exposing the identical model list; apiKey at registration level keeps
		// the provider visible in model selection.
		pi.registerProvider(name, {
			name: name,
			baseUrl: cfg.baseUrl,
			apiKey: cfg.apiKey,
			api: cfg.api,
			models,
			streamSimple,
		});
	}
}
