import { describe, expect, test } from "vitest";
import { buildSystemPrompt } from "../src/core/system-prompt.js";

describe("buildSystemPrompt", () => {
	describe("empty tools", () => {
		test("shows (none) for empty tools list", () => {
			const prompt = buildSystemPrompt({
				activeTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Available tools:\n(none)");
		});

		test("shows file paths guideline even with no tools", () => {
			const prompt = buildSystemPrompt({
				activeTools: [],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("Show file paths clearly");
		});
	});

	describe("default tools", () => {
		test("includes all default tools when provided", () => {
			const prompt = buildSystemPrompt({
				activeTools: [
					{ name: "read", description: "Read file contents" },
					{ name: "bash", description: "Execute bash commands" },
					{ name: "edit", description: "Edit files" },
					{ name: "write", description: "Write files" },
				],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- bash:");
			expect(prompt).toContain("- edit:");
			expect(prompt).toContain("- write:");
		});
	});

	describe("extension tools", () => {
		test("includes extension tools with their descriptions", () => {
			const prompt = buildSystemPrompt({
				activeTools: [
					{ name: "read", description: "Read file contents" },
					{ name: "tree_search", description: "Browse and search project files" },
					{ name: "lsp_diagnostics", description: "Get compiler errors and warnings" },
				],
				contextFiles: [],
				skills: [],
			});

			expect(prompt).toContain("- read:");
			expect(prompt).toContain("- tree_search:");
			expect(prompt).toContain("- lsp_diagnostics:");
		});
	});
});
