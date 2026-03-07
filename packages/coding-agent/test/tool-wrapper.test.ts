/**
 * Tests for wrapRegisteredTool: sideEffects field propagation through ToolDefinition and wrappers.
 * Tests for ToolRegistry: duplicate handling with last-write-wins semantics.
 */

import { Type } from "@sinclair/typebox";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionRunner } from "../src/core/extensions/runner.js";
import type { RegisteredTool, ToolDefinition } from "../src/core/extensions/types.js";
import { wrapRegisteredTool } from "../src/core/extensions/wrapper.js";
import { ToolRegistry } from "../src/core/tool-registry.js";

// Mock runner
function createMockRunner(): ExtensionRunner {
	return {
		createContext: () => ({
			ui: {},
			hasUI: false,
			cwd: "/tmp",
			sessionManager: {} as any,
			modelRegistry: {} as any,
			model: undefined,
			isIdle: () => true,
			abort: () => {},
			hasPendingMessages: () => false,
			shutdown: () => {},
			getContextUsage: () => undefined,
			compact: () => {},
			getSystemPrompt: () => "",
		}),
		hasHandlers: () => false,
		emitToolCall: async () => undefined,
		emitToolResult: async () => undefined,
	} as any;
}

describe("wrapRegisteredTool", () => {
	describe("sideEffects field propagation", () => {
		it("accepts sideEffects: false (read-only tool)", () => {
			const readTool: ToolDefinition = {
				name: "custom_read",
				label: "Custom Reader",
				description: "Custom read tool",
				parameters: Type.Object({}),
				sideEffects: false,
				execute: async () => ({
					content: [{ type: "text" as const, text: "data" }],
					details: undefined,
				}),
			};

			expect(readTool.sideEffects).toBe(false);
		});

		it("accepts sideEffects: true (side-effect tool)", () => {
			const writeTool: ToolDefinition = {
				name: "custom_write",
				label: "Custom Writer",
				description: "Custom write tool",
				parameters: Type.Object({}),
				sideEffects: true,
				execute: async () => ({
					content: [],
					details: undefined,
				}),
			};

			expect(writeTool.sideEffects).toBe(true);
		});

		it("accepts undefined sideEffects (safe default)", () => {
			const unknownTool: ToolDefinition = {
				name: "unknown_tool",
				label: "Unknown",
				description: "Unknown tool",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [],
					details: undefined,
				}),
			};

			expect(unknownTool.sideEffects).toBeUndefined();
		});

		it("preserves sideEffects: false when wrapping", () => {
			const definition: ToolDefinition = {
				name: "read_only",
				label: "Reader",
				description: "Read only",
				parameters: Type.Object({}),
				sideEffects: false,
				execute: async () => ({
					content: [{ type: "text" as const, text: "data" }],
					details: undefined,
				}),
			};

			const registered: RegisteredTool = {
				definition,
				extensionPath: "test/extension",
			};

			const runner = createMockRunner();
			const agentTool = wrapRegisteredTool(registered, runner);

			expect(agentTool.sideEffects).toBe(false);
		});

		it("preserves sideEffects: true when wrapping", () => {
			const definition: ToolDefinition = {
				name: "side_effect",
				label: "Writer",
				description: "Has side effects",
				parameters: Type.Object({}),
				sideEffects: true,
				execute: async () => ({
					content: [],
					details: undefined,
				}),
			};

			const registered: RegisteredTool = {
				definition,
				extensionPath: "test/extension",
			};

			const runner = createMockRunner();
			const agentTool = wrapRegisteredTool(registered, runner);

			expect(agentTool.sideEffects).toBe(true);
		});

		it("preserves sideEffects: undefined when wrapping", () => {
			const definition: ToolDefinition = {
				name: "unknown",
				label: "Unknown",
				description: "Unknown",
				parameters: Type.Object({}),
				execute: async () => ({
					content: [],
					details: undefined,
				}),
			};

			const registered: RegisteredTool = {
				definition,
				extensionPath: "test/extension",
			};

			const runner = createMockRunner();
			const agentTool = wrapRegisteredTool(registered, runner);

			expect(agentTool.sideEffects).toBeUndefined();
		});

		it("preserves all tool properties when copying sideEffects", () => {
			const definition: ToolDefinition = {
				name: "full_tool",
				label: "Full Tool",
				description: "A complete tool definition",
				parameters: Type.Object({
					input: Type.String(),
				}),
				sideEffects: false,
				execute: async () => ({
					content: [{ type: "text" as const, text: "result" }],
					details: { status: "ok" },
				}),
			};

			const registered: RegisteredTool = {
				definition,
				extensionPath: "test/extension",
			};

			const runner = createMockRunner();
			const agentTool = wrapRegisteredTool(registered, runner);

			expect(agentTool.name).toBe("full_tool");
			expect(agentTool.label).toBe("Full Tool");
			expect(agentTool.description).toBe("A complete tool definition");
			expect(agentTool.sideEffects).toBe(false);
			expect(agentTool.parameters).toBeDefined();
		});
	});

	describe("execution semantics", () => {
		it("executes the underlying tool when wrapped", async () => {
			const executeImpl = vi.fn(async () => ({
				content: [{ type: "text" as const, text: "test" }],
				details: undefined,
			}));

			const definition: ToolDefinition = {
				name: "test_exec",
				label: "Test",
				description: "Test execution",
				parameters: Type.Object({}),
				sideEffects: false,
				execute: executeImpl,
			};

			const registered: RegisteredTool = {
				definition,
				extensionPath: "test/extension",
			};

			const runner = createMockRunner();
			const agentTool = wrapRegisteredTool(registered, runner);

			const result = await agentTool.execute("call-1", {}, undefined, undefined);

			expect(executeImpl).toHaveBeenCalledOnce();
			expect(result.content).toEqual([{ type: "text", text: "test" }]);
		});
	});
});

describe("ToolRegistry duplicate handling", () => {
	function makeRegisteredTool(name: string, description: string, path = "ext/path"): RegisteredTool {
		return {
			definition: {
				name,
				label: name,
				description,
				parameters: Type.Object({}),
				execute: async () => ({ content: [], details: undefined }),
			},
			extensionPath: path,
		};
	}

	it("last-write-wins when extension tools with the same name are registered", () => {
		const registry = new ToolRegistry();
		registry.registerExtension(makeRegisteredTool("shared", "first", "ext/a"));
		registry.registerExtension(makeRegisteredTool("shared", "second", "ext/b"));

		const entry = registry.getEntry("shared");
		expect(entry).toBeDefined();
		expect(entry?.origin).toBe("extension");
		if (entry?.origin === "extension") {
			expect(entry.registeredTool.definition.description).toBe("second");
		}
	});

	it("records duplicates for diagnostic purposes", () => {
		const registry = new ToolRegistry();
		registry.registerExtension(makeRegisteredTool("tool", "v1", "ext/a"));
		registry.registerExtension(makeRegisteredTool("tool", "v2", "ext/b"));

		const duplicates = registry.getDuplicates();
		expect(duplicates).toHaveLength(1);
		expect(duplicates[0]?.name).toBe("tool");
		expect(duplicates[0]?.previousOrigin).toBe("extension");
		expect(duplicates[0]?.incomingOrigin).toBe("extension");
	});

	it("all extension tools including duplicates reach ToolRegistry from getAllRegisteredTools", () => {
		// Simulate what AgentSession does: feed all registered tools into ToolRegistry
		// (getAllRegisteredTools() no longer pre-deduplicates)
		const toolA1 = makeRegisteredTool("shared", "from-ext-a", "ext/a");
		const toolA2 = makeRegisteredTool("unique-a", "only-in-a", "ext/a");
		const toolB1 = makeRegisteredTool("shared", "from-ext-b", "ext/b");

		// Simulate what runner.getAllRegisteredTools() now returns (no deduplication)
		const allTools = [toolA1, toolA2, toolB1];

		const registry = new ToolRegistry();
		for (const tool of allTools) {
			registry.registerExtension(tool);
		}

		// Both unique-a and shared are present
		expect(registry.has("shared")).toBe(true);
		expect(registry.has("unique-a")).toBe(true);

		// last-write-wins: ext/b's version of "shared" wins
		const sharedEntry = registry.getEntry("shared");
		if (sharedEntry?.origin === "extension") {
			expect(sharedEntry.registeredTool.definition.description).toBe("from-ext-b");
		}

		// Duplicate recorded
		expect(registry.getDuplicates()).toHaveLength(1);
	});
});
