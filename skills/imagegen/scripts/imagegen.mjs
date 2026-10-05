#!/usr/bin/env node
/**
 * imagegen CLI — protocol-independent image generation & editing against the
 * OpenAI Images API. Bundled with the pi-model-images skill and invoked by
 * the agent through the shell, replacing the former registered `imagegen`
 * tool (the tool list stays lean; the skill routes on demand).
 *
 * Configuration is identical to the former tool:
 *   ~/.pi/agent/pi-model-images.json  (agent dir honors PI_CODING_AGENT_DIR)
 *     { "baseUrl", "apiKey", "model", "size", "quality" }
 * with PI_IMAGEGEN_* env overrides (env > file > default; apiKey falls back
 * to OPENAI_API_KEY; "$VAR"/"${VAR}" env references are resolved).
 *
 * Output contract (stdout): human summary first, then one marker line per
 * image at the very end — trailing placement survives shell-tool output
 * truncation:
 *
 *   PI_IMAGEGEN_FILE /home/<user>/.pi/images/<sha1-16>.png
 *
 * The pi-model-images extension scans tool results for these markers and
 * injects the referenced images back into the conversation as image blocks
 * (inline terminal display + model iteration). Keep the marker literal in
 * sync with extensions/model-images.ts.
 *
 * Zero dependencies: Node builtins only (requires Node >= 18 for fetch).
 */

import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const MARKER = "PI_IMAGEGEN_FILE";
const IMG_DIR = path.join(os.homedir(), ".pi", "images");
const CONFIG_FILENAME = "pi-model-images.json";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";
const DEFAULT_MODEL = "gpt-image-2";
const MAX_EDIT_IMAGES = 5;
const MAX_OUTPUT_IMAGES = 10;
const DEFAULT_TIMEOUT_SEC = 300;
let TIMEOUT_SEC = DEFAULT_TIMEOUT_SEC;

const MIME_BY_EXT = {
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".gif": "image/gif",
};
const FILE_URI_IMAGE_GLOBAL = /!\[[^\]]*\]\(file:\/\/(\/[^)\s]+)\)/g;

function fail(message) {
	console.error(`imagegen: ${message}`);
	process.exit(1);
}

// =============================================================================
// Configuration (mirrors the former extension-side tool config exactly)
// =============================================================================

function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function readSettings() {
	try {
		const parsed = JSON.parse(fs.readFileSync(path.join(getAgentDir(), CONFIG_FILENAME), "utf8"));
		return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
	} catch (err) {
		if (err && err.code !== "ENOENT") {
			console.error(`imagegen: failed to read ${CONFIG_FILENAME} — ${err instanceof Error ? err.message : String(err)}`);
		}
		return {};
	}
}

/** Resolves pi's `$VAR` / "${VAR}" apiKey env-reference convention. */
function resolveEnvRef(value) {
	const m = /^\$\{([^}]+)\}$/.exec(value) ?? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
	return m ? (process.env[m[1]] ?? "") : value;
}

function loadConfig(overrides) {
	const settings = readSettings();
	const str = (envVar, key, fallback) => {
		const fromSettings = settings[key];
		const value = process.env[envVar] ?? (typeof fromSettings === "string" && fromSettings.trim() ? fromSettings : undefined);
		return (value ?? fallback).trim();
	};
	return {
		baseUrl: (overrides.baseUrl || str("PI_IMAGEGEN_BASE_URL", "baseUrl", DEFAULT_BASE_URL)).replace(/\/+$/, ""),
		model: overrides.model || str("PI_IMAGEGEN_MODEL", "model", DEFAULT_MODEL),
		size: overrides.size || str("PI_IMAGEGEN_SIZE", "size", "auto"),
		quality: overrides.quality || str("PI_IMAGEGEN_QUALITY", "quality", "auto"),
		apiKey: (
			process.env.PI_IMAGEGEN_API_KEY ||
			(typeof settings.apiKey === "string" ? resolveEnvRef(settings.apiKey.trim()) : "") ||
			process.env.OPENAI_API_KEY ||
			""
		).trim(),
	};
}

// =============================================================================
// Image persistence (content-addressed, same scheme as the extension)
// =============================================================================

function mimeFromOutputFormat(format) {
	switch (String(format || "").toLowerCase()) {
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

function mimeFromFilePath(filePath) {
	return MIME_BY_EXT[path.extname(filePath).toLowerCase()];
}

function saveBase64(b64, mimeType) {
	const ext = mimeType === "image/jpeg" ? "jpg" : mimeType === "image/webp" ? "webp" : mimeType === "image/gif" ? "gif" : "png";
	const name = `${createHash("sha1").update(b64).digest("hex").slice(0, 16)}.${ext}`;
	fs.mkdirSync(IMG_DIR, { recursive: true });
	const filePath = path.join(IMG_DIR, name);
	fs.writeFileSync(filePath, Buffer.from(b64, "base64"));
	return filePath;
}

function readImageDataUrl(rawPath, cwd) {
	const filePath = path.resolve(cwd, rawPath.trim());
	const mimeType = mimeFromFilePath(filePath);
	if (!mimeType) {
		throw new Error(`unsupported image type for \`${filePath}\` (expected png/jpg/webp/gif)`);
	}
	let bytes;
	try {
		bytes = fs.readFileSync(filePath);
	} catch (err) {
		throw new Error(`unable to read referenced image \`${filePath}\` — ${err instanceof Error ? err.message : String(err)}`);
	}
	return `data:${mimeType};base64,${bytes.toString("base64")}`;
}

// =============================================================================
// --last-images: recent conversation images from the current session file
// =============================================================================

/**
 * Reads the session JSONL and reconstructs the ACTIVE branch by walking the
 * parentId chain from the newest entry (matches the in-memory branch the old
 * tool saw via ctx.sessionManager.getBranch(); plain file order could pick up
 * abandoned branch entries after a rewind).
 */
function readSessionBranch(sessionFile) {
	let raw;
	try {
		raw = fs.readFileSync(sessionFile, "utf8");
	} catch (err) {
		throw new Error(`unable to read session file \`${sessionFile}\` — ${err instanceof Error ? err.message : String(err)}`);
	}
	const entries = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		try {
			entries.push(JSON.parse(trimmed));
		} catch {
			// tolerate a partially written trailing line
		}
	}
	const byId = new Map();
	for (const entry of entries) {
		if (entry && typeof entry.id === "string") byId.set(entry.id, entry);
	}
	const branch = [];
	const visited = new Set();
	let cursor = entries.length ? entries[entries.length - 1] : null;
	while (cursor && !visited.has(cursor)) {
		visited.add(cursor);
		branch.push(cursor);
		const parentId = typeof cursor.parentId === "string" ? cursor.parentId : null;
		cursor = parentId ? (byId.get(parentId) ?? null) : null;
	}
	return branch; // newest-first
}

/**
 * Newest-first scan for conversation images — image blocks in
 * user/assistant/toolResult messages plus file:// markdown saved by this
 * package (restricted to IMG_DIR). Mirrors the former tool's collectRecentImages.
 */
function collectRecentImages(count, sessionFile) {
	const collected = [];
	const seen = new Set();
	const push = (data, mimeType) => {
		if (!data || seen.has(data)) return;
		seen.add(data);
		collected.push({ data, mimeType });
	};
	for (const entry of readSessionBranch(sessionFile)) {
		if (collected.length >= count) break;
		if (entry?.type !== "message") continue;
		const message = entry.message;
		if (message?.role !== "user" && message?.role !== "assistant" && message?.role !== "toolResult") continue;
		const blocks = Array.isArray(message?.content) ? message.content : [];
		for (let j = blocks.length - 1; j >= 0 && collected.length < count; j--) {
			const block = blocks[j];
			if (block?.type === "image" && typeof block.data === "string") {
				push(block.data, typeof block.mimeType === "string" ? block.mimeType : "image/png");
			} else if (block?.type === "text" && typeof block.text === "string" && block.text.includes("](file://")) {
				const matches = [...block.text.matchAll(FILE_URI_IMAGE_GLOBAL)];
				for (let k = matches.length - 1; k >= 0 && collected.length < count; k--) {
					const filePath = matches[k][1];
					if (!filePath.startsWith(IMG_DIR + path.sep)) continue; // only package-saved images
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
		throw new Error(`requested the last ${count} conversation images, but only ${collected.length} were available`);
	}
	collected.reverse(); // oldest-first input order
	return collected;
}

// =============================================================================
// Images API (request shape mirrors the former tool / codex)
// =============================================================================

async function callImagesApi(cfg, endpoint, body, signal) {
	let response;
	try {
		response = await fetch(`${cfg.baseUrl}${endpoint}`, {
			method: "POST",
			headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		if (signal?.aborted) fail(`request aborted or timed out after ${cfg.timeoutSec}s`);
		fail(`request failed — ${err instanceof Error ? err.message : String(err)}`);
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
		fail(`image request failed (${message})`);
	}
	let json;
	try {
		json = await response.json();
	} catch (err) {
		fail(`failed to decode response — ${err instanceof Error ? err.message : String(err)}`);
	}
	if (!Array.isArray(json?.data) || json.data.length === 0) {
		fail("response contained no image data");
	}
	return json;
}

async function extractImageDatum(item, fallbackMime, signal) {
	if (typeof item?.b64_json === "string" && item.b64_json) {
		return { data: item.b64_json, mimeType: fallbackMime };
	}
	const url = typeof item?.url === "string" ? item.url : "";
	if (url.startsWith("data:")) {
		const m = /^data:([^;]+);base64,(.+)$/s.exec(url);
		if (!m) fail("malformed data: URL in response");
		return { data: m[2], mimeType: m[1] };
	}
	if (/^https?:\/+\//.test(url)) {
		let response;
		try {
			response = await fetch(url, { signal });
		} catch (err) {
			if (signal?.aborted) fail("image download aborted or timed out");
			fail(`failed to download generated image — ${err instanceof Error ? err.message : String(err)}`);
		}
		if (!response.ok) fail(`failed to download generated image (HTTP ${response.status})`);
		const mimeType = (response.headers.get("content-type") || "").split(";")[0] || fallbackMime;
		const data = Buffer.from(await response.arrayBuffer()).toString("base64");
		return { data, mimeType: mimeType.startsWith("image/") ? mimeType : fallbackMime };
	}
	fail("response contained neither b64_json nor url image data");
}

// =============================================================================
// CLI
// =============================================================================

const USAGE = `imagegen — generate or edit images via the OpenAI Images API

One invocation submits exactly ONE generation request (one prompt + one
option set). Arrays of generation specs are intentionally not supported —
run the CLI once per prompt, or orchestrate repeated calls (e.g. codemode).
A single generation may take several reference images and may return
several output images.

Usage:
  imagegen.mjs --prompt "<text>" [options]                 # generate new image(s)
  imagegen.mjs --prompt "<text>" --image <p> [--image <p>] # edit local images (max 5)
  imagegen.mjs --prompt "<text>" --last-images <N>         # edit the last N conversation images

  --flag=value spelling is accepted for every value flag.

Options:
  --prompt <text>        Text description of the desired image, or the edit
                         instructions to apply. Required.
  --transparent          Request a transparent background (default opaque).
  --image <path>         Local image path to edit; repeat up to 5 times.
  --last-images <N>      Use the last N images from the current pi session
                         (1-5); requires PI_SESSION_FILE (set inside pi's shell).
  --n <count>            Request multiple images from this one generation
                         (1-10, default 1). Every returned image is saved.
  --model <id>           One-off model override (default from config).
  --size <WxH|auto>      One-off size override.
  --quality <lvl>        One-off quality override (low|medium|high|auto).
  -o, --output <path>    Additionally copy the result(s) to this path: a file
                         path for a single image, or a directory (created if
                         missing) when multiple images come back. The canonical
                         copy always stays in ~/.pi/images so inline display and
                         --last-images keep working.
  --timeout <seconds>    Request timeout (default ${DEFAULT_TIMEOUT_SEC}).
  -h, --help             Show this help.

Config: ~/.pi/agent/${CONFIG_FILENAME} (baseUrl / apiKey / model / size /
quality) with PI_IMAGEGEN_* env overrides; apiKey falls back to OPENAI_API_KEY.

Output: a summary line, then one "PI_IMAGEGEN_FILE <path>" marker line per
returned image (the pi-model-images extension injects those images back into
the conversation automatically).`;

function parseArgs(argv) {
	const opts = { images: [], overrides: {} };
	const next = (flag) => {
		const value = argv[++i];
		if (value === undefined) fail(`${flag} requires a value`);
		return value;
	};
	// Normalize `--flag=value` to `--flag value` so both spellings work.
	const normalized = [];
	for (const arg of argv) {
		const eq = arg.startsWith("--") ? arg.indexOf("=") : -1;
		if (eq > 2) normalized.push(arg.slice(0, eq), arg.slice(eq + 1));
		else normalized.push(arg);
	}
	argv = normalized;
	let i = 0;
	for (; i < argv.length; i++) {
		const arg = argv[i];
		switch (arg) {
			case "--prompt":
				opts.prompt = next(arg);
				break;
			case "--transparent":
				opts.transparent = true;
				break;
			case "--image":
				opts.images.push(next(arg));
				break;
			case "--n": {
				const raw = next(arg);
				const n = Number(raw);
				if (!Number.isInteger(n) || n < 1 || n > MAX_OUTPUT_IMAGES) {
					fail(`--n must be an integer between 1 and ${MAX_OUTPUT_IMAGES}`);
				}
				opts.n = n;
				break;
			}
			case "--last-images": {
				const raw = next(arg);
				const n = Number(raw);
				if (!Number.isInteger(n) || n < 1 || n > MAX_EDIT_IMAGES) {
					fail(`--last-images must be an integer between 1 and ${MAX_EDIT_IMAGES}`);
				}
				opts.lastImages = n;
				break;
			}
			case "--model":
				opts.overrides.model = next(arg);
				break;
			case "--size":
				opts.overrides.size = next(arg);
				break;
			case "--output":
			case "-o":
				opts.output = next(arg);
				break;
			case "--quality":
				opts.overrides.quality = next(arg);
				break;
			case "--timeout": {
				const raw = next(arg);
				const n = Number(raw);
				if (!Number.isFinite(n) || n <= 0) fail("--timeout must be a positive number of seconds");
				opts.timeoutSec = n;
				break;
			}
			case "--help":
			case "-h":
				console.log(USAGE);
				process.exit(0);
				break;
			default:
				fail(`unknown argument \`${arg}\` (see --help)`);
		}
	}
	return opts;
}

async function main() {
	const opts = parseArgs(process.argv.slice(2));
	TIMEOUT_SEC = opts.timeoutSec ?? DEFAULT_TIMEOUT_SEC;

	if (typeof opts.prompt !== "string" || !opts.prompt.trim()) fail("prompt is required (see --help)");
	const images = opts.images.filter((p) => typeof p === "string" && p.trim());
	const lastImages = opts.lastImages;
	if (images.length > 0 && lastImages != null) {
		fail("provide only one of --image or --last-images");
	}
	if (images.length > MAX_EDIT_IMAGES) {
		fail(`--image may be given at most ${MAX_EDIT_IMAGES} times`);
	}

	const cfg = loadConfig(opts.overrides);
	cfg.timeoutSec = TIMEOUT_SEC;
	if (!cfg.apiKey) {
		fail(`no API key configured — set apiKey in ~/.pi/agent/${CONFIG_FILENAME} (or PI_IMAGEGEN_API_KEY / OPENAI_API_KEY)`);
	}

	const base = {
		prompt: opts.prompt,
		background: opts.transparent ? "transparent" : "opaque",
		model: cfg.model,
		quality: cfg.quality,
		size: cfg.size,
		// Only sent when explicitly requested so the default request shape stays
		// identical to the former tool / codex.
		...(opts.n != null ? { n: opts.n } : {}),
	};

	let endpoint = "/images/generations";
	let body = { ...base };
	if (images.length > 0) {
		const cwd = process.cwd();
		endpoint = "/images/edits";
		body = { ...base, images: images.map((p) => ({ image_url: readImageDataUrl(p, cwd) })) };
	} else if (lastImages != null) {
		const sessionFile = process.env.PI_SESSION_FILE;
		if (!sessionFile) {
			fail("--last-images requires PI_SESSION_FILE; run inside pi's shell tool, or pass explicit paths with --image");
		}
		endpoint = "/images/edits";
		body = {
			...base,
			images: collectRecentImages(lastImages, sessionFile).map((img) => ({ image_url: `data:${img.mimeType};base64,${img.data}` })),
		};
	}

	const signal = AbortSignal.timeout(TIMEOUT_SEC * 1000);
	const json = await callImagesApi(cfg, endpoint, body, signal);
	const fallbackMime = mimeFromOutputFormat(json?.output_format);
	const saved = [];
	for (const item of json.data) {
		const { data, mimeType } = await extractImageDatum(item, fallbackMime, signal);
		saved.push({ filePath: saveBase64(data, mimeType), outputPath: undefined });
	}

	if (typeof opts.output === "string" && opts.output.trim()) {
		copyToOutput(saved, opts.output);
	}

	console.log(`imagegen: generated ${saved.length} image${saved.length > 1 ? "s" : ""} (model ${cfg.model})`);
	for (const s of saved) {
		console.log(`Saved to ${s.filePath}`);
		if (s.outputPath) console.log(`Also saved to ${s.outputPath}`);
	}
	// Markers reference the canonical ~/.pi/images copies only — the extension
	// catcher whitelists that directory, and mixing in --output paths would
	// inject the same image twice.
	for (const s of saved) console.log(`${MARKER} ${s.filePath}`);
}

/**
 * Copies saved images to the user-requested --output path. Single image: the
 * path may be a file (created, parents auto-created) or an existing/trailing-
 * slash directory. Multiple images: the path must be a directory (created if
 * missing); pointing at an existing file is an error. Existing files at the
 * targets are overwritten.
 */
function copyToOutput(saved, rawOutput) {
	const outPath = path.resolve(rawOutput.trim());
	const base = path.basename(saved[0].filePath);
	if (saved.length === 1) {
		let target = outPath;
		let isDir = false;
		try {
			isDir = fs.statSync(outPath).isDirectory();
		} catch {
			// not there yet — that's fine, we may create it
		}
		const wantsDir = isDir || /[\\/]$/.test(rawOutput.trim());
		if (wantsDir) target = path.join(outPath, base);
		try {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.copyFileSync(saved[0].filePath, target);
		} catch (err) {
			fail(`--output copy to \`${target}\` failed — ${err instanceof Error ? err.message : String(err)}`);
		}
		saved[0].outputPath = target;
		return;
	}
	let isFile = false;
	try {
		isFile = fs.statSync(outPath).isFile();
	} catch {
		// not there yet
	}
	if (isFile) {
		fail("--output points to an existing file but the request produced multiple images; pass a directory instead");
	}
	try {
		fs.mkdirSync(outPath, { recursive: true });
		for (const s of saved) {
			const target = path.join(outPath, path.basename(s.filePath));
			fs.copyFileSync(s.filePath, target);
			s.outputPath = target;
		}
	} catch (err) {
		fail(`--output copy to \`${outPath}\` failed — ${err instanceof Error ? err.message : String(err)}`);
	}
}

main().catch((err) => {
	fail(err instanceof Error ? err.message : String(err));
});
