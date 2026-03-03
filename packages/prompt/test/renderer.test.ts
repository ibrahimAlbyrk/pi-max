import { describe, expect, it } from "vitest";
import { renderTemplate } from "../src/renderer.js";
import type { RendererContext } from "../src/types.js";

function ctx(variables: Record<string, unknown>): RendererContext {
	return {
		variables,
		resolvePartial: (name: string) => `[partial:${name}]`,
	};
}

describe("renderer", () => {
	describe("variable replacement", () => {
		it("replaces simple variables", () => {
			const result = renderTemplate("Hello {{NAME}}!", ctx({ NAME: "World" }));
			expect(result).toBe("Hello World!");
		});

		it("replaces multiple variables", () => {
			const result = renderTemplate("{{A}} and {{B}}", ctx({ A: "foo", B: "bar" }));
			expect(result).toBe("foo and bar");
		});

		it("leaves undefined variables as empty", () => {
			const result = renderTemplate("Hello {{MISSING}}!", ctx({}));
			expect(result).toBe("Hello !");
		});

		it("resolves dotted paths", () => {
			const result = renderTemplate("{{user.name}}", ctx({ user: { name: "Alice" } }));
			expect(result).toBe("Alice");
		});

		it("handles numbers and booleans", () => {
			const result = renderTemplate("{{COUNT}} items, active: {{ACTIVE}}", ctx({ COUNT: 42, ACTIVE: true }));
			expect(result).toBe("42 items, active: true");
		});
	});

	describe("conditionals", () => {
		it("renders #if truthy branch", () => {
			const result = renderTemplate("{{#if SHOW}}visible{{/if}}", ctx({ SHOW: true }));
			expect(result).toBe("visible");
		});

		it("skips #if falsy branch", () => {
			const result = renderTemplate("{{#if SHOW}}visible{{/if}}", ctx({ SHOW: false }));
			expect(result).toBe("");
		});

		it("handles #if with equality check", () => {
			const result = renderTemplate('{{#if MODE == "dark"}}dark mode{{/if}}', ctx({ MODE: "dark" }));
			expect(result).toBe("dark mode");
		});

		it("handles #if with inequality check", () => {
			const result = renderTemplate('{{#if MODE != "light"}}not light{{/if}}', ctx({ MODE: "dark" }));
			expect(result).toBe("not light");
		});

		it("handles else branch", () => {
			const result = renderTemplate("{{#if SHOW}}yes{{else}}no{{/if}}", ctx({ SHOW: false }));
			expect(result).toBe("no");
		});

		it("handles else if chain", () => {
			const template = '{{#if MODE == "a"}}A{{else if MODE == "b"}}B{{else}}C{{/if}}';
			expect(renderTemplate(template, ctx({ MODE: "a" }))).toBe("A");
			expect(renderTemplate(template, ctx({ MODE: "b" }))).toBe("B");
			expect(renderTemplate(template, ctx({ MODE: "c" }))).toBe("C");
		});

		it("treats empty string as falsy", () => {
			const result = renderTemplate("{{#if VAL}}yes{{else}}no{{/if}}", ctx({ VAL: "" }));
			expect(result).toBe("no");
		});

		it("treats empty array as falsy", () => {
			const result = renderTemplate("{{#if ARR}}yes{{else}}no{{/if}}", ctx({ ARR: [] }));
			expect(result).toBe("no");
		});

		it("treats undefined as falsy", () => {
			const result = renderTemplate("{{#if MISSING}}yes{{else}}no{{/if}}", ctx({}));
			expect(result).toBe("no");
		});
	});

	describe("unless", () => {
		it("renders when falsy", () => {
			const result = renderTemplate("{{#unless DISABLED}}enabled{{/unless}}", ctx({ DISABLED: false }));
			expect(result).toBe("enabled");
		});

		it("skips when truthy", () => {
			const result = renderTemplate("{{#unless DISABLED}}enabled{{/unless}}", ctx({ DISABLED: true }));
			expect(result).toBe("");
		});
	});

	describe("each", () => {
		it("iterates over array", () => {
			const result = renderTemplate("{{#each ITEMS as item}}[{{item}}]{{/each}}", ctx({ ITEMS: ["a", "b", "c"] }));
			expect(result).toBe("[a][b][c]");
		});

		it("iterates over array of objects", () => {
			const items = [
				{ name: "read", desc: "Read files" },
				{ name: "write", desc: "Write files" },
			];
			const result = renderTemplate("{{#each TOOLS as t}}{{t.name}}: {{t.desc}}\n{{/each}}", ctx({ TOOLS: items }));
			expect(result).toBe("read: Read files\nwrite: Write files\n");
		});

		it("uses default item name when as clause omitted", () => {
			const result = renderTemplate("{{#each ITEMS}}[{{item}}]{{/each}}", ctx({ ITEMS: ["x", "y"] }));
			expect(result).toBe("[x][y]");
		});

		it("handles empty array", () => {
			const result = renderTemplate("{{#each ITEMS as item}}[{{item}}]{{/each}}", ctx({ ITEMS: [] }));
			expect(result).toBe("");
		});

		it("handles non-array gracefully", () => {
			const result = renderTemplate("{{#each ITEMS as item}}[{{item}}]{{/each}}", ctx({ ITEMS: "not-array" }));
			expect(result).toBe("");
		});
	});

	describe("partials", () => {
		it("resolves {{> partial}} syntax", () => {
			const result = renderTemplate("before {{> shared/safety}} after", ctx({}));
			expect(result).toBe("before [partial:shared/safety] after");
		});
	});

	describe("nested constructs", () => {
		it("nests if inside each", () => {
			const items = [
				{ name: "a", active: true },
				{ name: "b", active: false },
				{ name: "c", active: true },
			];
			const template = "{{#each ITEMS as item}}{{#if item.active}}{{item.name}}{{/if}}{{/each}}";
			const result = renderTemplate(template, ctx({ ITEMS: items }));
			expect(result).toBe("ac");
		});

		it("handles variables inside conditionals inside loops", () => {
			const tools = [
				{ name: "read", danger: false },
				{ name: "rm", danger: true },
			];
			const template = "{{#each TOOLS as t}}{{t.name}}{{#if t.danger}}[!]{{/if}} {{/each}}";
			const result = renderTemplate(template, ctx({ TOOLS: tools }));
			expect(result).toBe("read rm[!] ");
		});
	});

	describe("edge cases", () => {
		it("handles template with no tags", () => {
			const result = renderTemplate("plain text", ctx({}));
			expect(result).toBe("plain text");
		});

		it("handles empty template", () => {
			const result = renderTemplate("", ctx({}));
			expect(result).toBe("");
		});

		it("handles unclosed {{ as text", () => {
			const result = renderTemplate("hello {{ world", ctx({}));
			expect(result).toBe("hello {{ world");
		});
	});
});
