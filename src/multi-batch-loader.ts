/**
 * MultiBatchLoaderOverlay — a TUI overlay for /pruner now that shows one
 * animated spinner row per pending batch, updates it with streamed summary
 * character counts while running, and checks each row off as the
 * corresponding LLM summarization call completes.
 *
 * Construction requires knowing the batch list up-front (call
 * capturePendingBatches() before opening the overlay), which lets the
 * component pre-build all rows and their spinner labels.
 */

import type { CapturedBatch } from "./types.js";
import { Container, Loader } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import { formatCompactCount } from "./stats.js";

export class MultiBatchLoaderOverlay extends Container {
  private readonly loaders: Loader[];
  private readonly batches: CapturedBatch[];
  private _onAbort?: () => void;

  constructor(tui: any, theme: any, batches: CapturedBatch[]) {
    super();
    this.batches = batches;
    this.loaders = [];

    const total = batches.length;

    // Top border
    this.addChild(new DynamicBorder());

    for (let i = 0; i < total; i++) {
      // Mirror the colour scheme used by BorderedLoader:
      //   spinner  → accent colour
      //   message  → muted colour
      const loader = new Loader(
        tui,
        (s: string) => theme.fg("accent", s),
        (s: string) => theme.fg("muted", s),
        this.runningLabel(i),
      );
      this.loaders.push(loader);
      this.addChild(loader);
    }

    // Bottom border
    this.addChild(new DynamicBorder());
  }

  set onAbort(fn: () => void) {
    this._onAbort = fn;
  }

  private runningLabel(index: number, receivedChars = 0): string {
    const b = this.batches[index];
    const total = this.batches.length;
    const n = b.toolCalls.length;
    const received = receivedChars > 0 ? `  received ${formatCompactCount(receivedChars)} chars` : "";
    return `Batch ${index + 1}/${total}  (${n} tool call${n !== 1 ? "s" : ""})  summarizing…${received}`;
  }

  /** Explicitly mark a row as running. */
  markRunning(index: number): void {
    this.loaders[index].setMessage(this.runningLabel(index));
  }

  /** Update the row with the number of summary characters received so far. */
  markReceivedChars(index: number, receivedChars: number): void {
    this.loaders[index].setMessage(this.runningLabel(index, receivedChars));
  }

  /** Stop the spinner and show a ✓ checkmark for the completed batch row. */
  markDone(index: number): void {
    const b = this.batches[index];
    const n = b.toolCalls.length;
    const total = this.batches.length;
    this.loaders[index].stop();
    this.loaders[index].setMessage(
      `✓  Batch ${index + 1}/${total}  done  (${n} tool call${n !== 1 ? "s" : ""})`,
    );
  }

  /** Stop the spinner and show a ⚠ warning for a batch that was skipped. */
  markSkipped(index: number): void {
    const total = this.batches.length;
    this.loaders[index].stop();
    this.loaders[index].setMessage(`⚠  Batch ${index + 1}/${total}  skipped`);
  }

  /** Forward Esc / q to the abort handler so the overlay can be dismissed. */
  handleInput(data: string): boolean {
    if (data === "\x1b" || data === "q") {
      this._onAbort?.();
      return true;
    }
    return false;
  }
}
