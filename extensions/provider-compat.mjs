/**
 * Provider-level compat for the same-name takeover (Layer 4).
 *
 * A registered extension provider replaces the models.json-derived provider for
 * that name, and pi's extension path builds each model from the definitions the
 * extension passed in — it never re-applies the provider's own `compat`. Keys
 * that live only at provider level are therefore lost with the takeover.
 *
 * The one that matters here is session affinity: `sendSessionAffinityHeaders`
 * and `sessionAffinityFormat` are what make pi send the header a router reads to
 * keep a session on the upstream that holds its prompt cache. Losing them is
 * silent (requests still succeed), so it has to be applied explicitly.
 *
 * Model-level compat keeps precedence, mirroring pi's own provider-then-model
 * merge.
 */
export function withProviderCompat(models, compat) {
	if (!compat || typeof compat !== "object" || Array.isArray(compat)) return models;
	return models.map((model) => {
		const own = model?.compat && typeof model.compat === "object" && !Array.isArray(model.compat)
			? model.compat : {};
		return { ...model, compat: { ...compat, ...own } };
	});
}
