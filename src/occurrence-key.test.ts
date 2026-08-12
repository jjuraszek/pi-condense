import { describe, expect, test } from "bun:test";
import { occKey, parseOccKey, bareToolCallId, resultTimestampOf } from "./occurrence-key.js";

describe("occKey", () => {
  test("joins id and timestamp", () => {
    expect(occKey("bash_23", 1700)).toBe("bash_23@1700");
  });

  test("returns the bare id when the timestamp is absent (legacy shape)", () => {
    expect(occKey("bash_23", undefined)).toBe("bash_23");
  });

  test("round-trips through parseOccKey", () => {
    expect(parseOccKey("bash_23@1700")).toEqual({ toolCallId: "bash_23", resultTimestamp: 1700 });
  });

  test("treats a key with no separator as a bare id", () => {
    expect(parseOccKey("bash_23")).toEqual({ toolCallId: "bash_23" });
    expect("resultTimestamp" in parseOccKey("bash_23")).toBe(false);
  });

  test("treats a trailing non-numeric segment as part of a bare id", () => {
    // github-copilot ids embed base64 payloads after a '|' and may contain '@'
    expect(parseOccKey("call_abc@sha")).toEqual({ toolCallId: "call_abc@sha" });
  });

  test("splits on the LAST separator so ids containing '@' survive", () => {
    expect(parseOccKey("call@abc@1700")).toEqual({ toolCallId: "call@abc", resultTimestamp: 1700 });
  });

  test("bareToolCallId strips the occurrence suffix", () => {
    expect(bareToolCallId("bash_23@1700")).toBe("bash_23");
    expect(bareToolCallId("bash_23")).toBe("bash_23");
  });
});

describe("resultTimestampOf", () => {
  test("passes a number through", () => {
    expect(resultTimestampOf(1700)).toBe(1700);
  });

  test("returns undefined for undefined", () => {
    expect(resultTimestampOf(undefined)).toBeUndefined();
  });

  test("returns undefined for a string", () => {
    expect(resultTimestampOf("1700")).toBeUndefined();
  });

  test("returns undefined for null", () => {
    expect(resultTimestampOf(null)).toBeUndefined();
  });

  test("passes NaN through (typeof NaN === 'number'; a NaN timestamp cannot arise from pi's typed ToolResultMessage.timestamp)", () => {
    expect(resultTimestampOf(NaN)).toBeNaN();
  });
});
