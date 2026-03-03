import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parsePromptContent, parsePromptFile } from "../src/parser.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");
const EXT = ".prompt.md";

describe("parser", () => {
	describe("parsePromptFile", () => {
		it("parses a file with full frontmatter", () => {
			const result = parsePromptFile(resolve(FIXTURES, "system/base.prompt.md"), FIXTURES, EXT);

			expect(result.meta.name).toBe("system/base");
			expect(result.meta.description).toBe("Base system prompt");
			expect(result.meta.version).toBe(1);
			expect(result.meta.category).toBe("system");
			expect(result.meta.variables).toHaveLength(2);
			expect(result.meta.variables[0].name).toBe("AGENT_NAME");
			expect(result.meta.variables[0].type).toBe("string");
			expect(result.meta.variables[0].required).toBe(true);
			expect(result.meta.variables[1].name).toBe("VERBOSE");
			expect(result.meta.variables[1].default).toBe(false);
			expect(result.rawBody).toContain("{{AGENT_NAME}}");
		});

		it("parses a file with extends and includes", () => {
			const result = parsePromptFile(resolve(FIXTURES, "system/child.prompt.md"), FIXTURES, EXT);

			expect(result.meta.extends).toBe("system/base");
			expect(result.meta.includes).toEqual(["shared/safety"]);
			expect(result.meta.variables).toHaveLength(2);
		});

		it("parses a file with no frontmatter", () => {
			const result = parsePromptFile(resolve(FIXTURES, "no-frontmatter.prompt.md"), FIXTURES, EXT);

			expect(result.meta.name).toBe("no-frontmatter");
			expect(result.meta.description).toBe("");
			expect(result.meta.variables).toHaveLength(0);
			expect(result.rawBody).toBe("Just plain text with no frontmatter at all.");
		});

		it("derives category from file path", () => {
			const system = parsePromptFile(resolve(FIXTURES, "system/base.prompt.md"), FIXTURES, EXT);
			const tools = parsePromptFile(resolve(FIXTURES, "tools/read.prompt.md"), FIXTURES, EXT);
			const root = parsePromptFile(resolve(FIXTURES, "no-frontmatter.prompt.md"), FIXTURES, EXT);

			expect(system.meta.category).toBe("system");
			expect(tools.meta.category).toBe("tools");
			expect(root.meta.category).toBe("root");
		});
	});

	describe("parsePromptContent", () => {
		it("parses content string with frontmatter", () => {
			const content = `---
name: test-prompt
description: A test
variables:
  - name: FOO
    type: string
    required: true
---
Hello {{FOO}}`;

			const result = parsePromptContent(content, "/fake/test.prompt.md", "/fake", EXT);
			expect(result.meta.name).toBe("test-prompt");
			expect(result.meta.variables[0].name).toBe("FOO");
			expect(result.rawBody).toBe("Hello {{FOO}}");
		});

		it("handles invalid YAML gracefully", () => {
			const content = `---
: invalid: yaml: [
---
body`;

			expect(() => parsePromptContent(content, "/fake/bad.prompt.md", "/fake", EXT)).toThrow("Invalid YAML");
		});

		it("validates variable types", () => {
			const content = `---
name: bad-var
variables:
  - name: X
    type: invalidtype
---
body`;

			expect(() => parsePromptContent(content, "/fake/bad.prompt.md", "/fake", EXT)).toThrow("invalid type");
		});

		it("defaults variable type to string", () => {
			const content = `---
name: default-type
variables:
  - name: X
---
body`;

			const result = parsePromptContent(content, "/fake/test.prompt.md", "/fake", EXT);
			expect(result.meta.variables[0].type).toBe("string");
			expect(result.meta.variables[0].required).toBe(true);
		});
	});
});
