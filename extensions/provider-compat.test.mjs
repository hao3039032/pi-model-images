import assert from "node:assert/strict";
import test from "node:test";
import { withProviderCompat } from "./provider-compat.mjs";

// The gateway compat that must survive the same-name takeover: without it pi
// stops sending x-session-id and a router can no longer keep a session on the
// upstream that holds its prompt cache.
const gateway = { sendSessionAffinityHeaders: true, sessionAffinityFormat: "openrouter" };

test("carries provider-level session affinity onto every model", () => {
	const models = [{ id: "a" }, { id: "b", compat: { thinkingFormat: "zai" } }];
	const out = withProviderCompat(models, gateway);
	assert.equal(out[0].compat.sendSessionAffinityHeaders, true);
	assert.equal(out[0].compat.sessionAffinityFormat, "openrouter");
	assert.equal(out[1].compat.thinkingFormat, "zai");
	assert.equal(out[1].compat.sendSessionAffinityHeaders, true);
	assert.deepEqual(out.map((m) => m.id), ["a", "b"]);
});

test("model-level compat wins over the provider's, as in pi's own merge", () => {
	const models = [{ id: "a", compat: { sendSessionAffinityHeaders: false, sessionAffinityFormat: "openai" } }];
	const out = withProviderCompat(models, gateway);
	assert.equal(out[0].compat.sendSessionAffinityHeaders, false);
	assert.equal(out[0].compat.sessionAffinityFormat, "openai");
});

test("leaves models untouched when the provider declares no compat", () => {
	const models = [{ id: "a" }];
	assert.equal(withProviderCompat(models, undefined), models);
	assert.deepEqual(withProviderCompat(models, undefined), [{ id: "a" }]);
});

test("does not mutate the input models", () => {
	const models = [{ id: "a", compat: { thinkingFormat: "zai" } }];
	withProviderCompat(models, gateway);
	assert.deepEqual(models, [{ id: "a", compat: { thinkingFormat: "zai" } }]);
});
