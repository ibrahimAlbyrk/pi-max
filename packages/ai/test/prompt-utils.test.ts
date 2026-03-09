import { describe, expect, it } from "vitest";
import { flattenSystemPrompt, normalizeSystemPrompt } from "../src/prompt-utils.js";
import type { SystemPromptBlock } from "../src/types.js";

describe("normalizeSystemPrompt", () => {
	it("returns empty array for undefined", () => {
		expect(normalizeSystemPrompt(undefined)).toEqual([]);
	});

	it("wraps a string in a single block", () => {
		expect(normalizeSystemPrompt("hello")).toEqual([{ text: "hello" }]);
	});

	it("returns blocks as-is", () => {
		const blocks: SystemPromptBlock[] = [
			{ text: "block1", cache: true },
			{ text: "block2", cache: false },
		];
		expect(normalizeSystemPrompt(blocks)).toBe(blocks);
	});

	it("returns empty array for empty string", () => {
		// Empty string is falsy → empty array
		expect(normalizeSystemPrompt("")).toEqual([]);
	});

	it("returns empty array for empty block array", () => {
		expect(normalizeSystemPrompt([])).toEqual([]);
	});
});

describe("flattenSystemPrompt", () => {
	it("returns undefined for undefined", () => {
		expect(flattenSystemPrompt(undefined)).toBeUndefined();
	});

	it("returns the string as-is", () => {
		expect(flattenSystemPrompt("hello")).toBe("hello");
	});

	it("joins blocks with double newline", () => {
		const blocks: SystemPromptBlock[] = [{ text: "block1" }, { text: "block2" }];
		expect(flattenSystemPrompt(blocks)).toBe("block1\n\nblock2");
	});

	it("returns undefined for empty block array", () => {
		expect(flattenSystemPrompt([])).toBeUndefined();
	});

	it("handles single block", () => {
		expect(flattenSystemPrompt([{ text: "only" }])).toBe("only");
	});

	it("returns undefined for empty string", () => {
		// Empty string is falsy → returns undefined
		expect(flattenSystemPrompt("")).toBeUndefined();
	});
});
