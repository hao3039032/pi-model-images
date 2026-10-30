import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// The CLI runs main() on import, so it can only be exercised as a subprocess.
// fileURLToPath instead of import.meta.dirname keeps the suite on Node >= 18
// (import.meta.dirname needs 20.11).
const CLI_PATH = fileURLToPath(new URL("./scripts/imagegen.mjs", import.meta.url));
const TINY_PNG_B64 = "iVBORw0KGgo="; // 1x1-ish PNG signature bytes — enough for the save path
// Fail-fast paths never reach fetch; this URL guarantees no real API traffic if one ever does.
const UNREACHABLE_BASE_URL = "http://127.0.0.1:1/v1";
const CLI_WATCHDOG_MS = 30_000;

/**
 * Env for a CLI run: every inherited PI_IMAGEGEN_* var, API key, and session
 * var is stripped so the developer's shell cannot leak into the assertions, and HOME is
 * redirected into the temp workspace so the CLI's image cache never touches the
 * real ~/.pi. os.homedir() reads USERPROFILE on Windows and ignores HOME, so both
 * are redirected.
 */
function cleanEnv(dir, extra = {}) {
	const env = { ...process.env };
	for (const key of Object.keys(env)) {
		if (key.startsWith("PI_IMAGEGEN_") || key === "OPENAI_API_KEY" || key === "PI_SESSION_FILE" || key === "PI_CODING_AGENT_DIR") {
			delete env[key];
		}
	}
	return {
		...env,
		HOME: dir,
		USERPROFILE: dir,
		PI_CODING_AGENT_DIR: dir,
		PI_IMAGEGEN_API_KEY: "test-key",
		PI_IMAGEGEN_BASE_URL: UNREACHABLE_BASE_URL,
		...extra,
	};
}

/** Isolated agent dir (config file lives at its root); caller removes it. */
function makeWorkspace(config) {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imagegen-test-"));
	if (config) fs.writeFileSync(path.join(dir, "pi-model-images.json"), JSON.stringify(config));
	return dir;
}

function runCli(args, env) {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [CLI_PATH, ...args], { cwd: env.PI_CODING_AGENT_DIR, env });
		let stdout = "";
		let stderr = "";
		// A hung CLI must not hang the suite forever. unref() keeps the timer
		// from holding the process open on its own.
		const watchdog = setTimeout(() => child.kill("SIGKILL"), CLI_WATCHDOG_MS);
		watchdog.unref();
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk) => (stdout += chunk));
		child.stderr.on("data", (chunk) => (stderr += chunk));
		child.on("error", (err) => {
			clearTimeout(watchdog);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(watchdog);
			resolve({ code, stdout, stderr });
		});
	});
}

/**
 * Records each request (path, parsed JSON body or null, raw text) and answers
 * with one tiny PNG. Edit requests are multipart, so an unparsable body must
 * fail only the request that sent it, not abort the whole test file.
 */
async function startStubServer() {
	const requests = [];
	const server = http.createServer((req, res) => {
		let raw = "";
		req.setEncoding("utf8");
		req.on("data", (chunk) => (raw += chunk));
		req.on("end", () => {
			let body = null;
			try {
				body = JSON.parse(raw);
			} catch {
				body = null;
			}
			requests.push({ path: req.url, body, raw });
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }));
		});
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	return {
		baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
		requests,
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

/**
 * Runs one generation against a fresh stub server; returns the result, the raw
 * requests, the parsed bodies, and whatever `inspect` returned. `inspect` runs
 * after the CLI exits but before the temp workspace is deleted, so on-disk
 * assertions (the saved image) have to happen inside it.
 */
async function generate({ args = [], config, env = {}, inspect } = {}) {
	const dir = makeWorkspace(config);
	const server = await startStubServer();
	try {
		const result = await runCli(["--prompt", "a red square", ...args], cleanEnv(dir, { PI_IMAGEGEN_BASE_URL: server.baseUrl, ...env }));
		return {
			result,
			requests: server.requests,
			sent: server.requests.map((request) => request.body),
			inspected: inspect ? inspect({ dir, result }) : undefined,
		};
	} finally {
		await server.close();
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

/** Path from the single `PI_IMAGEGEN_FILE <path>` marker line. */
function markerFilePath(stdout) {
	const match = /^PI_IMAGEGEN_FILE (.+)$/m.exec(stdout);
	assert.ok(match, `expected a PI_IMAGEGEN_FILE marker line in:\n${stdout}`);
	return match[1];
}

/** Runs a path that must fail (or exit) before any request is made. */
async function runWithoutServer(args, extraEnv = {}) {
	const dir = makeWorkspace();
	try {
		return await runCli(args, cleanEnv(dir, extraEnv));
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
}

test("--help prints usage and exits 0", async () => {
	const { code, stdout } = await runWithoutServer(["--help"]);
	assert.equal(code, 0);
	assert.match(stdout, /Usage:/);
});

test("an invalid --background value fails before any request", async () => {
	const { code, stderr } = await runWithoutServer(["--prompt", "a red square", "--background", "bogus"]);
	assert.equal(code, 1);
	assert.match(stderr, /background must be one of transparent\|opaque\|auto \(got `bogus`\)/);
});

test("mixing --transparent and --background is rejected in either order", async () => {
	const transparentFirst = await runWithoutServer(["--prompt", "a red square", "--transparent", "--background", "opaque"]);
	assert.equal(transparentFirst.code, 1);
	assert.match(transparentFirst.stderr, /provide only one of --transparent or --background/);

	const backgroundFirst = await runWithoutServer(["--prompt", "a red square", "--background", "opaque", "--transparent"]);
	assert.equal(backgroundFirst.code, 1);
	assert.match(backgroundFirst.stderr, /provide only one of --transparent or --background/);
});

test("an invalid PI_IMAGEGEN_BACKGROUND value fails before any request", async () => {
	const { code, stderr } = await runWithoutServer(["--prompt", "a red square"], { PI_IMAGEGEN_BACKGROUND: "bogus" });
	assert.equal(code, 1);
	assert.match(stderr, /background must be one of transparent\|opaque\|auto \(got `bogus`\)/);
});

test("repeating the same background spelling is last-wins, not a conflict", async () => {
	const repeated = await generate({ args: ["--background", "transparent", "--background", "opaque"] });
	assert.equal(repeated.result.code, 0, repeated.result.stderr);
	assert.equal(repeated.sent[0].background, "opaque");

	const aliasRepeated = await generate({ args: ["--transparent", "--transparent"] });
	assert.equal(aliasRepeated.result.code, 0, aliasRepeated.result.stderr);
	assert.equal(aliasRepeated.sent[0].background, "transparent");
});

test("the default request sends background=auto and model=gpt-image-2.5-sunburst", async () => {
	const { result, requests, sent, inspected } = await generate({
		// Runs before the temp workspace — which is also HOME here — is deleted.
		inspect: ({ result: cli }) => {
			const filePath = markerFilePath(cli.stdout);
			return fs.existsSync(filePath) ? fs.readFileSync(filePath) : null;
		},
	});
	assert.equal(result.code, 0, result.stderr);
	assert.equal(requests.length, 1);
	assert.equal(requests[0].path, "/v1/images/generations");
	assert.equal(sent.length, 1);
	assert.equal(sent[0].background, "auto");
	assert.equal(sent[0].model, "gpt-image-2.5-sunburst");
	assert.match(result.stdout, /PI_IMAGEGEN_FILE /);
	// The marker must point at a real file: 8 bytes is what TINY_PNG_B64 decodes to.
	assert.ok(inspected, "expected the marked image file to exist on disk");
	assert.equal(inspected.length, 8);
});

test("--background overrides the default", async () => {
	const { result, sent } = await generate({ args: ["--background", "opaque"] });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(sent[0].background, "opaque");
});

test("--background is lowercased", async () => {
	const { result, sent } = await generate({ args: ["--background", "TRANSPARENT"] });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(sent[0].background, "transparent");
});

test("--background strips surrounding whitespace before lowercasing", async () => {
	const { result, sent } = await generate({ args: ["--background", " AUTO "] });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(sent[0].background, "auto");
});

test("--background=value spelling is accepted", async () => {
	const { result, sent } = await generate({ args: ["--background=opaque"] });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(sent[0].background, "opaque");
});

test("edits send a multipart body that carries the background field", async () => {
	// Any readable file with an image extension is enough — the CLI does not decode it.
	const refDir = fs.mkdtempSync(path.join(os.tmpdir(), "imagegen-ref-"));
	const refPath = path.join(refDir, "ref.png");
	fs.writeFileSync(refPath, Buffer.from(TINY_PNG_B64, "base64"));
	try {
		const { result, requests } = await generate({ args: ["--background", "transparent", "--image", refPath] });
		assert.equal(result.code, 0, result.stderr);
		assert.equal(requests.length, 1);
		assert.equal(requests[0].path, "/v1/images/edits");
		assert.equal(requests[0].body, null); // multipart, so no JSON body
		assert.match(requests[0].raw, /name="background"\r\n\r\ntransparent/);
	} finally {
		fs.rmSync(refDir, { recursive: true, force: true });
	}
});

test("the CLI flag wins over PI_IMAGEGEN_BACKGROUND", async () => {
	const { result, sent } = await generate({ args: ["--background", "auto"], env: { PI_IMAGEGEN_BACKGROUND: "transparent" } });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(sent[0].background, "auto");
});

test("the config file background is used when no flag or env var is set", async () => {
	const { result, sent } = await generate({ config: { background: "transparent" } });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(sent[0].background, "transparent");
});

test("PI_IMAGEGEN_BACKGROUND wins over the config file", async () => {
	const { result, sent } = await generate({ config: { background: "transparent" }, env: { PI_IMAGEGEN_BACKGROUND: "opaque" } });
	assert.equal(result.code, 0, result.stderr);
	assert.equal(sent[0].background, "opaque");
});

test("an empty PI_IMAGEGEN_BACKGROUND falls through to the config file, then the default", async () => {
	const fromConfig = await generate({ config: { background: "opaque" }, env: { PI_IMAGEGEN_BACKGROUND: "" } });
	assert.equal(fromConfig.result.code, 0, fromConfig.result.stderr);
	assert.equal(fromConfig.sent[0].background, "opaque");

	const fromDefault = await generate({ env: { PI_IMAGEGEN_BACKGROUND: "" } });
	assert.equal(fromDefault.result.code, 0, fromDefault.result.stderr);
	assert.equal(fromDefault.sent[0].background, "auto");
});
