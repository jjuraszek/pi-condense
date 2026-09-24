/**
 * Per-request image cap (`maxImagesPerRequest`).
 *
 * Providers reject a request carrying more images than their limit, and every
 * image a model has seen stays in the transcript, so a long session can cross
 * the limit and then fail on every request. Once a request carries more than
 * `max` images, `capImages` replaces the oldest ones with a text note, in steps
 * of half the cap so the prompt prefix changes rarely. It never mutates its
 * input; it returns `undefined` when nothing changes.
 */

export const IMAGE_OMITTED_NOTE =
  "[earlier image omitted from this request: over maxImagesPerRequest; read the file again to view it]";

type Block = { type?: unknown };

export function capImages<M extends object>(messages: M[], max: number): M[] | undefined {
  const total = messages.reduce((n, m) => {
    const content = (m as { content?: unknown }).content;
    return n + (Array.isArray(content) ? content.filter((b) => (b as Block)?.type === "image").length : 0);
  }, 0);
  if (total <= max) return undefined;
  // Omit the oldest images in steps of half the cap, not one per new image:
  // the omitted set then changes once per `step` new images, so the prompt
  // prefix (and the provider's prompt cache) stays stable in between.
  const step = Math.max(1, Math.ceil(max / 2));
  let toOmit = Math.min(total, Math.ceil((total - max) / step) * step);
  let result: M[] | undefined;
  for (let i = 0; i < messages.length && toOmit > 0; i++) {
    const content = (messages[i] as { content?: unknown }).content;
    if (!Array.isArray(content)) continue;
    let replaced: Block[] | undefined;
    for (let j = 0; j < content.length && toOmit > 0; j++) {
      if ((content[j] as Block)?.type !== "image") continue;
      replaced ??= content.slice() as Block[];
      replaced[j] = { type: "text", text: IMAGE_OMITTED_NOTE } as Block;
      toOmit--;
    }
    if (replaced) {
      result ??= messages.slice();
      result[i] = { ...messages[i], content: replaced } as M;
    }
  }
  return result;
}
