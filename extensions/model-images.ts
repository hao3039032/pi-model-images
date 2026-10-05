/**
 * model-images: transparent image-generation support for pi.
 *
 * No new providers, no model switching, and — since v0.2 — no registered
 * tools either. This extension:
 *
 * 1. imagegen CLI + skill (replaces the former registered `imagegen` tool) —
 *    a zero-dependency Node CLI bundled in the pi-model-images skill
 *    (skills/imagegen/scripts/imagegen.mjs) that calls the OpenAI Images API
 *    directly — one generation request per invocation (no batch arrays;
 *    orchestrate repeated calls for that, e.g. via codemode), with optional
 *    multi-reference editing and multi-image output. Invoked by the model
 *    through the ordinary shell tool, this extension watches every tool
 *    result for the CLI's `PI_IMAGEGEN_FILE <path>` marker lines and injects
 *    the referenced images back into the result as image blocks: inline
 *    terminal display, model iteration, and session persistence — the same
 *    experience the tool provided, without occupying a slot in the tool
 *    list. Markers in nested results (codemode-orchestrated calls) are shown
 *    through the model-image display message instead. Config lives in
 *    ~/.pi/agent/pi-model-images.json (see the skill's SKILL.md).
 *
 * 2. Same-name takeover — every models.json provider speaking
 *    `openai-responses` or `openai-completions` is re-registered with an
 *    identical model list plus an image-aware stream wrapper:
 *      - responses: rewrites `image_generation_call` output items (which the
 *        stock parser drops) into message items carrying file:// markdown
 *      - completions: rewrites `choices[].delta.images` (OpenRouter
 *        convention, also dropped by the stock parser) into delta.content
 *    anthropic-messages providers are left untouched (no protocol image
 *    field); they are covered by the CLI and layer 3.
 *
 * 3. Generic data-URI catcher — a `message_end` hook watches every assistant
 *    message regardless of provider; data:image URIs embedded in text are
 *    saved to disk and rewritten to file:// markdown.
 *
 * 4. Display — CLI-generated images are injected into tool results (image
 *    blocks render inline via kitty/iterm2 graphics protocols);
 *    stream-captured images are delivered as display-only custom messages
 *    rendered through the pi-tui Image component. `details` stays out of LLM
 *    context.
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
import { Image } from "@earendil-works/pi-tui";
import type { Component } from "@earendil-works/pi-tui";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const IMG_DIR = path.join(os.homedir(), ".pi", "images");
const IMG_MARKDOWN = /!\[image\]\(file:\/\/[^)]*\.pi\/images\/[^)]+\)/g;
const DATA_URI_IMAGE = /!\[([^\]]*)\]\((data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]+)\)/g;
const BARE_DATA_URI = /data:image\/[a-zA-Z0-9.+-]+;base64,[A-Za-z0-9+/=]{512,}/g;

/**
 * Marker emitted by the imagegen CLI (skills/imagegen/scripts/imagegen.mjs)
 * at the end of its stdout: `PI_IMAGEGEN_FILE <abs-path>`, one per image.
 * Keep the literal in sync with the CLI.
 */
const IMAGEGEN_MARKER_LINE = /PI_IMAGEGEN_FILE (\S+)/g;
const MAX_INJECT_IMAGES = 10; // matches the CLI's --n ceiling so every image of one generation is injected

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

/**
 * Content hashes already displayed or injected in this process; dedupes the
 * stream-capture, nested-call (codemode), and tool-result injection paths.
 */
const notifiedHashes = new Set<string>();

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
// imagegen CLI result catcher — display + conversation injection
// =============================================================================

/**
 * The imagegen CLI (skills/imagegen/scripts/imagegen.mjs) replaced the former
 * registered `imagegen` tool: the model invokes it through the ordinary shell
 * tool, guided by the imagegen skill. The CLI prints one
 * `PI_IMAGEGEN_FILE <abs-path>` marker line per generated image at the end of
 * its stdout; this catcher scans every tool result for those markers and
 * appends the referenced images as image blocks.
 *
 * This restores what the tool result used to provide: inline terminal display
 * (kitty/iterm2 via pi's tool-result rendering), model iteration (the image
 * enters the conversation so follow-up edits can target it), and session
 * persistence (the CLI's own `--last-images` scan finds these blocks later).
 *
 * Validation is strict: paths must resolve under IMG_DIR, exist, and map to a
 * known image extension; at most MAX_INJECT_IMAGES per result. The catcher is
 * a display/injection enhancement only — it never fails a tool result.
 *
 * Nested calls (e.g. bash inside a codemode script) carry parentToolCallId:
 * their results never render in the transcript and only reach the calling
 * tool as a string, so content injection would be silently dropped. Those
 * images are instead displayed through the model-image custom message. A
 * shared content-hash set prevents double display when the calling tool's
 * own result later echoes the same marker lines.
 */

const MIME_BY_EXT: Record<string, string> = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};

function mimeFromFilePath(filePath: string): string | undefined {
	return MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

function registerImagegenMarkerCatcher(pi: ExtensionAPI) {
	pi.on("tool_result", (event) => {
		try {
			const blocks = event.content ?? [];
			let text = "";
			for (const block of blocks) {
				if (block?.type === "text" && typeof block.text === "string") text += `\n${block.text}`;
			}
			if (!text.includes("PI_IMAGEGEN_FILE")) return; // fast path

			const seen = new Set<string>();
			const found: ImageDetails[] = [];
			for (const match of text.matchAll(IMAGEGEN_MARKER_LINE)) {
				if (found.length >= MAX_INJECT_IMAGES) break;
				const filePath = path.resolve(match[1]);
				if (seen.has(filePath)) continue;
				seen.add(filePath);
				if (!filePath.startsWith(IMG_DIR + path.sep)) continue; // only package-saved images
				const mimeType = mimeFromFilePath(filePath);
				if (!mimeType || !fs.existsSync(filePath)) continue;
				found.push({ data: fs.readFileSync(filePath).toString("base64"), mimeType, filePath });
			}
			if (found.length === 0) return;

			if (event.parentToolCallId) {
				// Nested result (codemode-orchestrated call): display via the
				// model-image custom message; notifyImage dedupes by content hash.
				for (const details of found) notifyImage?.(details);
				return;
			}

			// Top-level result: inject image blocks (inline display + model
			// iteration + session persistence). Skip images already displayed via
				// the nested path so an echoing caller result neither double-renders
			// nor duplicates image content.
			const images = found
				.filter((details) => {
					const hash = crypto.createHash("sha1").update(details.data).digest("hex").slice(0, 16);
					if (notifiedHashes.has(hash)) return false;
					notifiedHashes.add(hash);
					return true;
			})
				.map((details) => ({ type: "image" as const, data: details.data, mimeType: details.mimeType }));
			if (images.length === 0) return;
			return { content: [...blocks, ...images] };
		} catch (err) {
			console.error(
					`model-images: imagegen marker capture failed — ${err instanceof Error ? err.message : String(err)}`,
			);
		}
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
	// ---- Layer 1: imagegen CLI marker catcher (CLI + skill provide generation) ----
	registerImagegenMarkerCatcher(pi);

	// ---- Display layer: inline pixels via custom message + Image component ----
	pi.registerMessageRenderer<ImageDetails>("model-image", (message, _options, theme) => {
		const details = message.details;
		if (!details?.data || !details.mimeType) return undefined;
		return new Image(details.data, details.mimeType, { fallbackColor: (s) => theme.fg("toolOutput", s) }) as unknown as Component;
	});

	notifyImage = (details) => {
		try {
			const hash = crypto.createHash("sha1").update(details.data).digest("hex").slice(0, 16);
			if (notifiedHashes.has(hash)) return; // dedupe across completed+done and marker paths
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
