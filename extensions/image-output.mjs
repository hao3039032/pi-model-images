/** Versioned presentation metadata; pixels remain in ordinary tool-result content. */
export function appendGeneratedImages(event, images) {
	const content = event.content ?? [];
	const details = event.details && typeof event.details === "object" && !Array.isArray(event.details)
		? event.details : {};
	const previous = details.modelImages?.version === 1 && Array.isArray(details.modelImages.outputs)
		? details.modelImages.outputs : [];
	return {
		content: [...content, ...images.map(({ data, mimeType }) => ({ type: "image", data, mimeType }))],
		details: {
			...details,
			modelImages: {
				version: 1,
				outputs: [
					...previous,
					...images.map((image, index) => ({
						blockIndex: content.length + index,
						kind: "generated-image",
						filePath: image.filePath,
					})),
				],
			},
		},
		// Replacing content alone makes Pi discard structuredContent.
		...(event.structuredContent !== undefined ? { structuredContent: event.structuredContent } : {}),
	};
}
