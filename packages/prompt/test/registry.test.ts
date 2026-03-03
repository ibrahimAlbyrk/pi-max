import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CircularReferenceError, PromptNotFoundError, VariableRequiredError } from "../src/errors.js";
import { createPromptRegistry } from "../src/registry.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");

function createTestRegistry() {
	return createPromptRegistry({ templatesDir: FIXTURES });
}

describe("registry", () => {
	describe("list", () => {
		it("discovers all prompt files", () => {
			const registry = createTestRegistry();
			const names = registry.list();

			expect(names).toContain("system/base");
			expect(names).toContain("system/child");
			expect(names).toContain("tools/read");
			expect(names).toContain("shared/greeting");
			expect(names).toContain("shared/safety");
			expect(names).toContain("conditional");
			expect(names).toContain("auto-include");
			expect(names).toContain("no-frontmatter");
		});
	});

	describe("listByCategory", () => {
		it("filters by category", () => {
			const registry = createTestRegistry();

			const system = registry.listByCategory("system");
			expect(system).toContain("system/base");
			expect(system).toContain("system/child");
			expect(system).not.toContain("tools/read");

			const tools = registry.listByCategory("tools");
			expect(tools).toContain("tools/read");
		});
	});

	describe("getMeta", () => {
		it("returns metadata for a prompt", () => {
			const registry = createTestRegistry();
			const meta = registry.getMeta("system/base");

			expect(meta.name).toBe("system/base");
			expect(meta.description).toBe("Base system prompt");
			expect(meta.variables).toHaveLength(2);
			expect(meta.category).toBe("system");
		});

		it("throws for unknown prompt", () => {
			const registry = createTestRegistry();
			expect(() => registry.getMeta("nonexistent")).toThrow(PromptNotFoundError);
		});

		it("merges variables from extends chain", () => {
			const registry = createTestRegistry();
			const meta = registry.getMeta("system/child");

			// Should have AGENT_NAME (from parent), VERBOSE (overridden), WORKING_DIR (from child)
			const names = meta.variables.map((v) => v.name);
			expect(names).toContain("AGENT_NAME");
			expect(names).toContain("VERBOSE");
			expect(names).toContain("WORKING_DIR");

			// Child overrides VERBOSE default to true
			const verbose = meta.variables.find((v) => v.name === "VERBOSE");
			expect(verbose?.default).toBe(true);
		});
	});

	describe("render", () => {
		it("renders a simple prompt with variables", () => {
			const registry = createTestRegistry();
			const result = registry.render("system/base", { AGENT_NAME: "pi" });

			expect(result).toContain("You are pi, an AI assistant.");
		});

		it("renders with default values", () => {
			const registry = createTestRegistry();
			const result = registry.render("tools/read");

			expect(result).toContain("2000 lines");
			expect(result).toContain("50KB");
		});

		it("renders with custom values overriding defaults", () => {
			const registry = createTestRegistry();
			const result = registry.render("tools/read", { MAX_LINES: 500, MAX_KB: 25 });

			expect(result).toContain("500 lines");
			expect(result).toContain("25KB");
		});

		it("throws for missing required variable", () => {
			const registry = createTestRegistry();
			expect(() => registry.render("system/base")).toThrow(VariableRequiredError);
		});

		it("renders extends chain (parent + child)", () => {
			const registry = createTestRegistry();
			const result = registry.render("system/child", {
				AGENT_NAME: "pi",
				WORKING_DIR: "/home",
			});

			// Parent content should appear first
			expect(result).toContain("You are pi, an AI assistant.");
			// Child content should appear after
			expect(result).toContain("Current directory: /home");
			// Default VERBOSE is true in child, so verbose content should appear
			expect(result).toContain("You should provide detailed explanations.");
			// Included safety partial
			expect(result).toContain("Always follow safety guidelines.");
		});

		it("renders conditional logic", () => {
			const registry = createTestRegistry();

			const verbose = registry.render("conditional", { MODE: "verbose" });
			expect(verbose).toContain("Detailed mode active.");
			expect(verbose).not.toContain("Concise mode.");

			const concise = registry.render("conditional", { MODE: "concise" });
			expect(concise).toContain("Concise mode.");
			expect(concise).not.toContain("Detailed mode active.");

			const other = registry.render("conditional", { MODE: "other" });
			expect(other).toContain("Normal mode.");
		});

		it("renders each loops", () => {
			const registry = createTestRegistry();
			const tools = [
				{ name: "read", description: "Read files" },
				{ name: "write", description: "Write files" },
			];
			const result = registry.render("conditional", {
				MODE: "verbose",
				HAS_TOOLS: true,
				TOOLS: tools,
			});

			expect(result).toContain("- read: Read files");
			expect(result).toContain("- write: Write files");
		});

		it("renders unless blocks", () => {
			const registry = createTestRegistry();

			const writable = registry.render("conditional", { MODE: "verbose", IS_READONLY: false });
			expect(writable).toContain("You can write files.");

			const readonly = registry.render("conditional", { MODE: "verbose", IS_READONLY: true });
			expect(readonly).not.toContain("You can write files.");
		});

		it("renders auto-include mode", () => {
			const registry = createTestRegistry();
			const result = registry.render("auto-include");

			expect(result).toContain("Main content here.");
			expect(result).toContain("Hello and welcome!");
			expect(result).toContain("Always follow safety guidelines.");
		});
	});

	describe("circular references", () => {
		it("detects circular extends", () => {
			const registry = createTestRegistry();
			expect(() => registry.render("circular/a")).toThrow(CircularReferenceError);
		});
	});

	describe("invalidate", () => {
		it("clears specific prompt cache", () => {
			const registry = createTestRegistry();

			// First render caches the result
			registry.render("tools/read");
			// Invalidate
			registry.invalidate("tools/read");

			// Should still work (re-parses from disk)
			const result = registry.render("tools/read");
			expect(result).toContain("2000 lines");
		});

		it("full invalidate reloads everything", () => {
			const registry = createTestRegistry();
			registry.render("tools/read");
			registry.invalidate();

			const names = registry.list();
			expect(names).toContain("tools/read");
		});
	});

	describe("validate", () => {
		it("reports errors for circular references", () => {
			const registry = createTestRegistry();
			const results = registry.validate();

			const circularA = results.find((r) => r.promptName === "circular/a");
			expect(circularA?.errors.length).toBeGreaterThan(0);
			expect(circularA?.errors[0]).toContain("circular");
		});

		it("returns results for all prompts", () => {
			const registry = createTestRegistry();
			const results = registry.validate();

			expect(results.length).toBeGreaterThan(0);
			// Every prompt should have a result
			const names = results.map((r) => r.promptName);
			expect(names).toContain("system/base");
			expect(names).toContain("tools/read");
		});
	});
});
