/**
 * Tests for prompt template argument parsing and substitution.
 *
 * Tests verify:
 * - Argument parsing with quotes and special characters
 * - Placeholder substitution ($1, $2, $@, $ARGUMENTS)
 * - No recursive substitution of patterns in argument values
 * - Edge cases and integration between parsing and substitution
 */

import { mkdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	expandPromptTemplate,
	loadPromptTemplates,
	type PromptTemplate,
	parseCommandArgs,
	substituteArgs,
} from "../src/core/prompt-templates.js";

// ============================================================================
// substituteArgs
// ============================================================================

describe("substituteArgs", () => {
	test("should replace $ARGUMENTS with all args joined", () => {
		expect(substituteArgs("Test: $ARGUMENTS", ["a", "b", "c"])).toBe("Test: a b c");
	});

	test("should replace $@ with all args joined", () => {
		expect(substituteArgs("Test: $@", ["a", "b", "c"])).toBe("Test: a b c");
	});

	test("should replace $@ and $ARGUMENTS identically", () => {
		const args = ["foo", "bar", "baz"];
		expect(substituteArgs("Test: $@", args)).toBe(substituteArgs("Test: $ARGUMENTS", args));
	});

	// CRITICAL: argument values containing patterns should remain literal
	test("should NOT recursively substitute patterns in argument values", () => {
		expect(substituteArgs("$ARGUMENTS", ["$1", "$ARGUMENTS"])).toBe("$1 $ARGUMENTS");
		expect(substituteArgs("$@", ["$100", "$1"])).toBe("$100 $1");
		expect(substituteArgs("$ARGUMENTS", ["$100", "$1"])).toBe("$100 $1");
	});

	test("should support mixed $1, $2, and $ARGUMENTS", () => {
		expect(substituteArgs("$1: $ARGUMENTS", ["prefix", "a", "b"])).toBe("prefix: prefix a b");
	});

	test("should support mixed $1, $2, and $@", () => {
		expect(substituteArgs("$1: $@", ["prefix", "a", "b"])).toBe("prefix: prefix a b");
	});

	test("should handle empty arguments array with $ARGUMENTS", () => {
		expect(substituteArgs("Test: $ARGUMENTS", [])).toBe("Test: ");
	});

	test("should handle empty arguments array with $@", () => {
		expect(substituteArgs("Test: $@", [])).toBe("Test: ");
	});

	test("should handle empty arguments array with $1", () => {
		expect(substituteArgs("Test: $1", [])).toBe("Test: ");
	});

	test("should handle multiple occurrences of $ARGUMENTS", () => {
		expect(substituteArgs("$ARGUMENTS and $ARGUMENTS", ["a", "b"])).toBe("a b and a b");
	});

	test("should handle multiple occurrences of $@", () => {
		expect(substituteArgs("$@ and $@", ["a", "b"])).toBe("a b and a b");
	});

	test("should handle mixed occurrences of $@ and $ARGUMENTS", () => {
		expect(substituteArgs("$@ and $ARGUMENTS", ["a", "b"])).toBe("a b and a b");
	});

	test("should handle special characters in arguments", () => {
		// Note: $100 in argument doesn't get partially matched - full strings are substituted
		expect(substituteArgs("$1 $2: $ARGUMENTS", ["arg100", "@user"])).toBe("arg100 @user: arg100 @user");
	});

	test("should handle out-of-range numbered placeholders", () => {
		// Note: Out-of-range placeholders become empty strings (preserving spaces from template)
		expect(substituteArgs("$1 $2 $3 $4 $5", ["a", "b"])).toBe("a b   ");
	});

	test("should handle unicode characters", () => {
		expect(substituteArgs("$ARGUMENTS", ["日本語", "🎉", "café"])).toBe("日本語 🎉 café");
	});

	test("should preserve newlines and tabs in argument values", () => {
		expect(substituteArgs("$1 $2", ["line1\nline2", "tab\tthere"])).toBe("line1\nline2 tab\tthere");
	});

	test("should handle consecutive dollar patterns", () => {
		expect(substituteArgs("$1$2", ["a", "b"])).toBe("ab");
	});

	test("should handle quoted arguments with spaces", () => {
		expect(substituteArgs("$ARGUMENTS", ["first arg", "second arg"])).toBe("first arg second arg");
	});

	test("should handle single argument with $ARGUMENTS", () => {
		expect(substituteArgs("Test: $ARGUMENTS", ["only"])).toBe("Test: only");
	});

	test("should handle single argument with $@", () => {
		expect(substituteArgs("Test: $@", ["only"])).toBe("Test: only");
	});

	test("should handle $0 (zero index)", () => {
		expect(substituteArgs("$0", ["a", "b"])).toBe("");
	});

	test("should handle decimal number in pattern (only integer part matches)", () => {
		expect(substituteArgs("$1.5", ["a"])).toBe("a.5");
	});

	test("should handle $ARGUMENTS as part of word", () => {
		expect(substituteArgs("pre$ARGUMENTS", ["a", "b"])).toBe("prea b");
	});

	test("should handle $@ as part of word", () => {
		expect(substituteArgs("pre$@", ["a", "b"])).toBe("prea b");
	});

	test("should handle empty arguments in middle of list", () => {
		expect(substituteArgs("$ARGUMENTS", ["a", "", "c"])).toBe("a  c");
	});

	test("should handle trailing and leading spaces in arguments", () => {
		expect(substituteArgs("$ARGUMENTS", ["  leading  ", "trailing  "])).toBe("  leading   trailing  ");
	});

	test("should handle argument containing pattern partially", () => {
		expect(substituteArgs("Prefix $ARGUMENTS suffix", ["ARGUMENTS"])).toBe("Prefix ARGUMENTS suffix");
	});

	test("should handle non-matching patterns", () => {
		expect(substituteArgs("$A $$ $ $ARGS", ["a"])).toBe("$A $$ $ $ARGS");
	});

	test("should handle case variations (case-sensitive)", () => {
		expect(substituteArgs("$arguments $Arguments $ARGUMENTS", ["a", "b"])).toBe("$arguments $Arguments a b");
	});

	test("should handle both syntaxes in same command with same result", () => {
		const args = ["x", "y", "z"];
		const result1 = substituteArgs("$@ and $ARGUMENTS", args);
		const result2 = substituteArgs("$ARGUMENTS and $@", args);
		expect(result1).toBe(result2);
		expect(result1).toBe("x y z and x y z");
	});

	test("should handle very long argument lists", () => {
		const args = Array.from({ length: 100 }, (_, i) => `arg${i}`);
		const result = substituteArgs("$ARGUMENTS", args);
		expect(result).toBe(args.join(" "));
	});

	test("should handle numbered placeholders with single digit", () => {
		expect(substituteArgs("$1 $2 $3", ["a", "b", "c"])).toBe("a b c");
	});

	test("should handle numbered placeholders with multiple digits", () => {
		const args = Array.from({ length: 15 }, (_, i) => `val${i}`);
		expect(substituteArgs("$10 $12 $15", args)).toBe("val9 val11 val14");
	});

	test("should handle escaped dollar signs (literal backslash preserved)", () => {
		// Note: No escape mechanism exists - backslash is treated literally
		expect(substituteArgs("Price: \\$100", [])).toBe("Price: \\");
	});

	test("should handle mixed numbered and wildcard placeholders", () => {
		expect(substituteArgs("$1: $@ ($ARGUMENTS)", ["first", "second", "third"])).toBe(
			"first: first second third (first second third)",
		);
	});

	test("should handle command with no placeholders", () => {
		expect(substituteArgs("Just plain text", ["a", "b"])).toBe("Just plain text");
	});

	test("should handle command with only placeholders", () => {
		expect(substituteArgs("$1 $2 $@", ["a", "b", "c"])).toBe("a b a b c");
	});
});

// ============================================================================
// substituteArgs - Array Slicing (Bash-Style)
// ============================================================================

describe("substituteArgs - array slicing", () => {
	test(`should slice from index (\${@:N})`, () => {
		expect(substituteArgs(`\${@:2}`, ["a", "b", "c", "d"])).toBe("b c d");
		expect(substituteArgs(`\${@:1}`, ["a", "b", "c"])).toBe("a b c");
		expect(substituteArgs(`\${@:3}`, ["a", "b", "c", "d"])).toBe("c d");
	});

	test(`should slice with length (\${@:N:L})`, () => {
		expect(substituteArgs(`\${@:2:2}`, ["a", "b", "c", "d"])).toBe("b c");
		expect(substituteArgs(`\${@:1:1}`, ["a", "b", "c"])).toBe("a");
		expect(substituteArgs(`\${@:3:1}`, ["a", "b", "c", "d"])).toBe("c");
		expect(substituteArgs(`\${@:2:3}`, ["a", "b", "c", "d", "e"])).toBe("b c d");
	});

	test("should handle out of range slices", () => {
		expect(substituteArgs(`\${@:99}`, ["a", "b"])).toBe("");
		expect(substituteArgs(`\${@:5}`, ["a", "b"])).toBe("");
		expect(substituteArgs(`\${@:10:5}`, ["a", "b"])).toBe("");
	});

	test("should handle zero-length slices", () => {
		expect(substituteArgs(`\${@:2:0}`, ["a", "b", "c"])).toBe("");
		expect(substituteArgs(`\${@:1:0}`, ["a", "b"])).toBe("");
	});

	test("should handle length exceeding array", () => {
		expect(substituteArgs(`\${@:2:99}`, ["a", "b", "c"])).toBe("b c");
		expect(substituteArgs(`\${@:1:10}`, ["a", "b"])).toBe("a b");
	});

	test("should process slice before simple $@", () => {
		expect(substituteArgs(`\${@:2} vs $@`, ["a", "b", "c"])).toBe("b c vs a b c");
		expect(substituteArgs(`First: \${@:1:1}, All: $@`, ["x", "y", "z"])).toBe("First: x, All: x y z");
	});

	test("should not recursively substitute slice patterns in args", () => {
		expect(substituteArgs(`\${@:1}`, [`\${@:2}`, "test"])).toBe(`\${@:2} test`);
		expect(substituteArgs(`\${@:2}`, ["a", `\${@:3}`, "c"])).toBe(`\${@:3} c`);
	});

	test("should handle mixed usage with positional args", () => {
		expect(substituteArgs(`$1: \${@:2}`, ["cmd", "arg1", "arg2"])).toBe("cmd: arg1 arg2");
		expect(substituteArgs(`$1 $2 \${@:3}`, ["a", "b", "c", "d"])).toBe("a b c d");
	});

	test(`should treat \${@:0} as all args`, () => {
		expect(substituteArgs(`\${@:0}`, ["a", "b", "c"])).toBe("a b c");
	});

	test("should handle empty args array", () => {
		expect(substituteArgs(`\${@:2}`, [])).toBe("");
		expect(substituteArgs(`\${@:1}`, [])).toBe("");
	});

	test("should handle single arg array", () => {
		expect(substituteArgs(`\${@:1}`, ["only"])).toBe("only");
		expect(substituteArgs(`\${@:2}`, ["only"])).toBe("");
	});

	test("should handle slice in middle of text", () => {
		expect(substituteArgs(`Process \${@:2} with $1`, ["tool", "file1", "file2"])).toBe(
			"Process file1 file2 with tool",
		);
	});

	test("should handle multiple slices in one template", () => {
		expect(substituteArgs(`\${@:1:1} and \${@:2}`, ["a", "b", "c"])).toBe("a and b c");
		expect(substituteArgs(`\${@:1:2} vs \${@:3:2}`, ["a", "b", "c", "d", "e"])).toBe("a b vs c d");
	});

	test("should handle quoted arguments in slices", () => {
		expect(substituteArgs(`\${@:2}`, ["cmd", "first arg", "second arg"])).toBe("first arg second arg");
	});

	test("should handle special characters in sliced args", () => {
		expect(substituteArgs(`\${@:2}`, ["cmd", "$100", "@user", "#tag"])).toBe("$100 @user #tag");
	});

	test("should handle unicode in sliced args", () => {
		expect(substituteArgs(`\${@:1}`, ["日本語", "🎉", "café"])).toBe("日本語 🎉 café");
	});

	test("should combine positional, slice, and wildcard placeholders", () => {
		const template = `Run $1 on \${@:2:2}, then process $@`;
		const args = ["eslint", "file1.ts", "file2.ts", "file3.ts"];
		expect(substituteArgs(template, args)).toBe(
			"Run eslint on file1.ts file2.ts, then process eslint file1.ts file2.ts file3.ts",
		);
	});

	test("should handle slice with no spacing", () => {
		expect(substituteArgs(`prefix\${@:2}suffix`, ["a", "b", "c"])).toBe("prefixb csuffix");
	});

	test("should handle large slice lengths gracefully", () => {
		const args = Array.from({ length: 10 }, (_, i) => `arg${i + 1}`);
		expect(substituteArgs(`\${@:5:100}`, args)).toBe("arg5 arg6 arg7 arg8 arg9 arg10");
	});
});

// ============================================================================
// parseCommandArgs
// ============================================================================

describe("parseCommandArgs", () => {
	test("should parse simple space-separated arguments", () => {
		expect(parseCommandArgs("a b c")).toEqual(["a", "b", "c"]);
	});

	test("should parse quoted arguments with spaces", () => {
		expect(parseCommandArgs('"first arg" second')).toEqual(["first arg", "second"]);
	});

	test("should parse single-quoted arguments", () => {
		expect(parseCommandArgs("'first arg' second")).toEqual(["first arg", "second"]);
	});

	test("should parse mixed quote styles", () => {
		expect(parseCommandArgs('"double" \'single\' "double again"')).toEqual(["double", "single", "double again"]);
	});

	test("should handle empty string", () => {
		expect(parseCommandArgs("")).toEqual([]);
	});

	test("should handle extra spaces", () => {
		expect(parseCommandArgs("a  b   c")).toEqual(["a", "b", "c"]);
	});

	test("should handle tabs as separators", () => {
		expect(parseCommandArgs("a\tb\tc")).toEqual(["a", "b", "c"]);
	});

	test("should handle quoted empty string", () => {
		// Note: Empty quotes are skipped by current implementation
		expect(parseCommandArgs('"" " "')).toEqual([" "]);
	});

	test("should handle arguments with special characters", () => {
		expect(parseCommandArgs("$100 @user #tag")).toEqual(["$100", "@user", "#tag"]);
	});

	test("should handle unicode characters", () => {
		expect(parseCommandArgs("日本語 🎉 café")).toEqual(["日本語", "🎉", "café"]);
	});

	test("should handle newlines in arguments", () => {
		expect(parseCommandArgs('"line1\nline2" second')).toEqual(["line1\nline2", "second"]);
	});

	test("should handle escaped quotes inside quoted strings", () => {
		// Note: This implementation doesn't handle escaped quotes - backslash is literal
		expect(parseCommandArgs('"quoted \\"text\\""')).toEqual(["quoted \\text\\"]);
	});

	test("should handle trailing spaces", () => {
		expect(parseCommandArgs("a b c   ")).toEqual(["a", "b", "c"]);
	});

	test("should handle leading spaces", () => {
		expect(parseCommandArgs("   a b c")).toEqual(["a", "b", "c"]);
	});
});

// ============================================================================
// Integration
// ============================================================================

describe("parseCommandArgs + substituteArgs integration", () => {
	test("should parse and substitute together correctly", () => {
		const input = 'Button "onClick handler" "disabled support"';
		const args = parseCommandArgs(input);
		const template = "Create component $1 with features: $ARGUMENTS";
		const result = substituteArgs(template, args);
		expect(result).toBe("Create component Button with features: Button onClick handler disabled support");
	});

	test("should handle the example from README", () => {
		const input = 'Button "onClick handler" "disabled support"';
		const args = parseCommandArgs(input);
		const template = "Create a React component named $1 with features: $ARGUMENTS";
		const result = substituteArgs(template, args);
		expect(result).toBe(
			"Create a React component named Button with features: Button onClick handler disabled support",
		);
	});

	test("should produce same result with $@ and $ARGUMENTS", () => {
		const args = parseCommandArgs("feature1 feature2 feature3");
		const template1 = "Implement: $@";
		const template2 = "Implement: $ARGUMENTS";
		expect(substituteArgs(template1, args)).toBe(substituteArgs(template2, args));
	});
});

// ============================================================================
// expandPromptTemplate - Colon Separator for Nested Prompts
// ============================================================================

describe("expandPromptTemplate - colon separator", () => {
	const templates: PromptTemplate[] = [
		{
			name: "review",
			description: "Review code",
			content: "Review this code: $@",
			source: "project",
			filePath: "/prompts/review.md",
		},
		{
			name: "git/commit",
			description: "Git commit",
			content: "Write a commit message for: $@",
			source: "project",
			filePath: "/prompts/git/commit.md",
		},
		{
			name: "git/hooks/pre-push",
			description: "Pre-push hook",
			content: "Create a pre-push hook for: $1",
			source: "project",
			filePath: "/prompts/git/hooks/pre-push.md",
		},
	];

	test("should expand flat prompts as before", () => {
		expect(expandPromptTemplate("/review my code", templates)).toBe("Review this code: my code");
	});

	test("should expand nested prompts using colon separator", () => {
		expect(expandPromptTemplate("/git:commit fix login bug", templates)).toBe(
			"Write a commit message for: fix login bug",
		);
	});

	test("should expand deeply nested prompts using colon separator", () => {
		expect(expandPromptTemplate("/git:hooks:pre-push tests", templates)).toBe("Create a pre-push hook for: tests");
	});

	test("should return original text if no template matches", () => {
		expect(expandPromptTemplate("/unknown:command", templates)).toBe("/unknown:command");
	});

	test("should not expand text that doesn't start with /", () => {
		expect(expandPromptTemplate("git:commit test", templates)).toBe("git:commit test");
	});

	test("should handle nested prompt with no arguments", () => {
		expect(expandPromptTemplate("/git:commit", templates)).toBe("Write a commit message for: ");
	});
});

// ============================================================================
// expandPromptTemplate - Auto-append args when no placeholders
// ============================================================================

describe("expandPromptTemplate - auto-append args", () => {
	const templates: PromptTemplate[] = [
		{
			name: "no-placeholder",
			description: "No placeholder",
			content: "Do something useful",
			source: "project",
			filePath: "/prompts/no-placeholder.md",
		},
		{
			name: "has-positional",
			description: "Has $1",
			content: "Run $1 now",
			source: "project",
			filePath: "/prompts/has-positional.md",
		},
		{
			name: "has-wildcard",
			description: "Has $@",
			content: "Process: $@",
			source: "project",
			filePath: "/prompts/has-wildcard.md",
		},
		{
			name: "has-arguments",
			description: "Has $ARGUMENTS",
			content: "Handle $ARGUMENTS",
			source: "project",
			filePath: "/prompts/has-arguments.md",
		},
		{
			name: "has-slice",
			description: "Has slice",
			// biome-ignore lint/suspicious/noTemplateCurlyInString: this is a prompt template placeholder, not a JS template literal
			content: "Slice: ${@:2}",
			source: "project",
			filePath: "/prompts/has-slice.md",
		},
	];

	test("should append args when template has no placeholders", () => {
		expect(expandPromptTemplate("/no-placeholder extra context here", templates)).toBe(
			"Do something useful\n\nextra context here",
		);
	});

	test("should not append args when template has $1", () => {
		expect(expandPromptTemplate("/has-positional test", templates)).toBe("Run test now");
	});

	test("should not append args when template has $@", () => {
		expect(expandPromptTemplate("/has-wildcard a b c", templates)).toBe("Process: a b c");
	});

	test("should not append args when template has $ARGUMENTS", () => {
		expect(expandPromptTemplate("/has-arguments x y", templates)).toBe("Handle x y");
	});

	// biome-ignore lint/suspicious/noTemplateCurlyInString: this is a prompt template placeholder, not a JS template literal
	test("should not append args when template has ${@:...}", () => {
		expect(expandPromptTemplate("/has-slice a b c", templates)).toBe("Slice: b c");
	});

	test("should not append when no args provided", () => {
		expect(expandPromptTemplate("/no-placeholder", templates)).toBe("Do something useful");
	});

	test("should handle quoted args in append", () => {
		expect(expandPromptTemplate('/no-placeholder "only staged changes"', templates)).toBe(
			"Do something useful\n\nonly staged changes",
		);
	});
});

// ============================================================================
// loadPromptTemplates - Recursive Directory Loading
// ============================================================================

describe("loadPromptTemplates - recursive directory loading", () => {
	const testDir = join(tmpdir(), `pi-prompt-test-${Date.now()}`);
	const promptsDir = join(testDir, ".pi", "prompts");

	beforeAll(() => {
		// Create nested directory structure
		mkdirSync(join(promptsDir, "git", "hooks"), { recursive: true });
		mkdirSync(join(promptsDir, "docker"), { recursive: true });

		// Create template files
		writeFileSync(join(promptsDir, "review.md"), "---\ndescription: Review code\n---\nReview this code");
		writeFileSync(join(promptsDir, "git", "commit.md"), "---\ndescription: Git commit\n---\nWrite a commit message");
		writeFileSync(
			join(promptsDir, "git", "hooks", "pre-push.md"),
			"---\ndescription: Pre-push hook\n---\nCreate pre-push hook",
		);
		writeFileSync(join(promptsDir, "docker", "build.md"), "---\ndescription: Docker build\n---\nBuild docker image");
	});

	afterAll(() => {
		rmSync(testDir, { recursive: true, force: true });
	});

	test("should load flat templates with plain name", () => {
		const templates = loadPromptTemplates({ cwd: testDir, promptPaths: [promptsDir], includeDefaults: false });
		const review = templates.find((t) => t.name === "review");
		expect(review).toBeDefined();
		expect(review!.content).toContain("Review this code");
	});

	test("should load nested templates with slash-separated name", () => {
		const templates = loadPromptTemplates({ cwd: testDir, promptPaths: [promptsDir], includeDefaults: false });
		const gitCommit = templates.find((t) => t.name === "git/commit");
		expect(gitCommit).toBeDefined();
		expect(gitCommit!.content).toContain("Write a commit message");
	});

	test("should load deeply nested templates", () => {
		const templates = loadPromptTemplates({ cwd: testDir, promptPaths: [promptsDir], includeDefaults: false });
		const prePush = templates.find((t) => t.name === "git/hooks/pre-push");
		expect(prePush).toBeDefined();
		expect(prePush!.content).toContain("Create pre-push hook");
	});

	test("should load templates from multiple subdirectories", () => {
		const templates = loadPromptTemplates({ cwd: testDir, promptPaths: [promptsDir], includeDefaults: false });
		const dockerBuild = templates.find((t) => t.name === "docker/build");
		expect(dockerBuild).toBeDefined();
		expect(dockerBuild!.content).toContain("Build docker image");
	});

	test("should load all templates (flat + nested)", () => {
		const templates = loadPromptTemplates({ cwd: testDir, promptPaths: [promptsDir], includeDefaults: false });
		const names = templates.map((t) => t.name).sort();
		expect(names).toEqual(["docker/build", "git/commit", "git/hooks/pre-push", "review"]);
	});
});

// ============================================================================
// expandPromptTemplate - Multi-Invocation (mid-text)
// ============================================================================

describe("expandPromptTemplate - multi-invocation", () => {
	const templates: PromptTemplate[] = [
		{
			name: "review",
			description: "Review code",
			content: "Review this code: $@",
			source: "project",
			filePath: "/prompts/review.md",
		},
		{
			name: "git/commit",
			description: "Git commit",
			content: "Write a commit message for: $@",
			source: "project",
			filePath: "/prompts/git/commit.md",
		},
		{
			name: "explain",
			description: "Explain code",
			content: "Explain the following: $@",
			source: "project",
			filePath: "/prompts/explain.md",
		},
		{
			name: "no-placeholder",
			description: "No placeholder",
			content: "Do something useful",
			source: "project",
			filePath: "/prompts/no-placeholder.md",
		},
	];

	test("should expand a single mid-text invocation", () => {
		const result = expandPromptTemplate("fix this bug /review the auth module", templates);
		expect(result).toBe("fix this bug\n\nReview this code: the auth module");
	});

	test("should expand multiple invocations", () => {
		const result = expandPromptTemplate("/review the code /git:commit summarize changes", templates);
		expect(result).toBe("Review this code: the code\n\nWrite a commit message for: summarize changes");
	});

	test("should preserve text before first invocation", () => {
		const result = expandPromptTemplate("please /explain this function", templates);
		expect(result).toBe("please\n\nExplain the following: this function");
	});

	test("should handle invocation with no arguments at end", () => {
		const result = expandPromptTemplate("do this /review", templates);
		expect(result).toBe("do this\n\nReview this code: ");
	});

	test("should handle text with no invocations", () => {
		const result = expandPromptTemplate("just normal text here", templates);
		expect(result).toBe("just normal text here");
	});

	test("should not match slash in middle of word", () => {
		const result = expandPromptTemplate("path/review not a command", templates);
		expect(result).toBe("path/review not a command");
	});

	test("should handle invocation with no-placeholder template mid-text", () => {
		const result = expandPromptTemplate("context /no-placeholder extra args", templates);
		expect(result).toBe("context\n\nDo something useful\n\nextra args");
	});

	test("should handle three invocations", () => {
		const result = expandPromptTemplate("/review code /explain logic /git:commit done", templates);
		expect(result).toBe("Review this code: code\n\nExplain the following: logic\n\nWrite a commit message for: done");
	});
});
