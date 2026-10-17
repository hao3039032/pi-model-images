import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { appendGeneratedImages } from "./image-output.mjs";

const image = { data: "QUJD", mimeType: "image/png", filePath: "C:\\images\\a.png" };

test("marks only newly appended images and preserves tool details and structured output", () => {
  const inputImage = { type: "image", data: "REF", mimeType: "image/jpeg" };
  const event = { content: [inputImage, { type: "text", text: "CLI output" }], details: { truncation: { truncated: false } }, structuredContent: { answer: 42 } };
  const output = appendGeneratedImages(event, [image, { ...image, filePath: "b.png" }]);
  assert.equal(output.content[0], inputImage);
  assert.deepEqual(output.details.modelImages.outputs.map((item) => item.blockIndex), [2, 3]);
  assert.equal(output.details.modelImages.outputs[0].kind, "generated-image");
  assert.equal(output.details.truncation, event.details.truncation);
  assert.equal(output.structuredContent, event.structuredContent);
  assert.equal(event.content.length, 2);
  assert.equal(event.details.modelImages, undefined);
  assert.equal("data" in output.details.modelImages.outputs[0], false);
});

test("composes with earlier generated output metadata", () => {
  const first = appendGeneratedImages({ content: [], details: undefined }, [image]);
  const second = appendGeneratedImages(first, [image]);
  assert.deepEqual(second.details.modelImages.outputs.map((item) => item.blockIndex), [0, 1]);
  assert.equal("structuredContent" in second, false);
});

test("the marker catcher tags actual injected images; nested calls keep their explicit custom-message route", () => {
  const source = readFileSync(new URL("./model-images.ts", import.meta.url), "utf8");
  assert.match(source, /return appendGeneratedImages\(event, images\)/);
  assert.match(source, /if \(event\.parentToolCallId\)[\s\S]*?notifyImage\?\.\(details\);[\s\S]*?return;/);
  assert.match(source, /customType: "model-image"/);
});
