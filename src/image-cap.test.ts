import { describe, it, expect } from "bun:test";
import { IMAGE_OMITTED_NOTE, capImages, imageLimitFor } from "./image-cap.js";

const image = (n: number) => ({ type: "image", data: `img${n}`, mimeType: "image/png" });
const imagesOf = (messages: any[]) =>
  messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b: any) => b.type === "image");

describe("capImages", () => {
  const reads = (count: number) =>
    Array.from({ length: count }, (_, n) => ({
      role: "toolResult",
      content: [{ type: "text", text: "read" }, image(n)],
    }));

  it("omits the oldest images once over the cap, in steps of half the cap", () => {
    const out = capImages(reads(31), 30)!;
    expect(imagesOf(out).map((b: any) => b.data)).toEqual(Array.from({ length: 16 }, (_, n) => `img${n + 15}`));
    expect(out[0].content[1]).toEqual({ type: "text", text: IMAGE_OMITTED_NOTE });
    expect(out[0].content[0]).toEqual({ type: "text", text: "read" });
  });

  it("keeps the omitted prefix stable while new images arrive within a step", () => {
    const omitted = (count: number) =>
      (capImages(reads(count), 20) ?? reads(count)).filter((m: any) => m.content[1].type === "text").length;
    expect([20, 21, 25, 30, 31, 40, 41].map(omitted)).toEqual([0, 10, 10, 10, 20, 20, 30]);
  });

  it("counts images within one message newest-last", () => {
    const out = capImages([{ role: "user", content: [image(1), image(2), image(3)] }], 2)!;
    expect(out[0].content.map((b: any) => b.data ?? b.text)).toEqual([IMAGE_OMITTED_NOTE, "img2", "img3"]);
  });

  it("does not mutate its input", () => {
    const messages = [{ role: "user", content: [image(1), image(2)] }];
    capImages(messages, 1);
    expect(imagesOf(messages)).toHaveLength(2);
  });

  it("returns undefined when the request is already under the cap", () => {
    expect(capImages([{ role: "user", content: [image(1)] }, { role: "assistant", content: "text" }], 5)).toBeUndefined();
  });
});

describe("imageLimitFor", () => {
  it("prefers the configured number over the built-in", () => {
    expect(imageLimitFor(30, "anthropic-messages")).toBe(30);
  });

  it("falls back to the built-in Anthropic Messages limit", () => {
    expect(imageLimitFor(null, "anthropic-messages")).toBe(100);
  });

  it("returns null for an API without a built-in limit or no model", () => {
    expect(imageLimitFor(null, "openai-completions")).toBeNull();
    expect(imageLimitFor(null, undefined)).toBeNull();
  });
});
