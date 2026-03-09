import { describe, expect, it } from "vitest";
import { getModel } from "../src/models.js";
import type { Context, SystemPromptBlock } from "../src/types.js";

describe("System Prompt Blocks — Anthropic Provider", () => {
	it("should create per-block cache_control for multi-block system prompt", async () => {
		const model = getModel("anthropic", "claude-3-5-haiku-20241022");
		let capturedPayload: any = null;

		const blocks: SystemPromptBlock[] = [
			{ text: "Static base prompt content", cache: true },
			{ text: "Dynamic runtime content", cache: true },
		];

		const context: Context = {
			systemPrompt: blocks,
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};

		const { streamAnthropic } = await import("../src/providers/anthropic.js");

		try {
			const s = streamAnthropic(model, context, {
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});
			for await (const event of s) {
				if (event.type === "error") break;
			}
		} catch {
			// Expected to fail with fake key
		}

		expect(capturedPayload).not.toBeNull();
		// Should have 2 system blocks
		expect(capturedPayload.system).toHaveLength(2);
		expect(capturedPayload.system[0].type).toBe("text");
		expect(capturedPayload.system[0].text).toBe("Static base prompt content");
		expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral" });
		expect(capturedPayload.system[1].type).toBe("text");
		expect(capturedPayload.system[1].text).toBe("Dynamic runtime content");
		expect(capturedPayload.system[1].cache_control).toEqual({ type: "ephemeral" });
	});

	it("should omit cache_control for blocks with cache: false", async () => {
		const model = getModel("anthropic", "claude-3-5-haiku-20241022");
		let capturedPayload: any = null;

		const blocks: SystemPromptBlock[] = [
			{ text: "Cached block", cache: true },
			{ text: "Uncached block", cache: false },
		];

		const context: Context = {
			systemPrompt: blocks,
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};

		const { streamAnthropic } = await import("../src/providers/anthropic.js");

		try {
			const s = streamAnthropic(model, context, {
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});
			for await (const event of s) {
				if (event.type === "error") break;
			}
		} catch {
			// Expected
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload.system).toHaveLength(2);
		expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral" });
		expect(capturedPayload.system[1].cache_control).toBeUndefined();
	});

	it("should handle string systemPrompt (backward compat)", async () => {
		const model = getModel("anthropic", "claude-3-5-haiku-20241022");
		let capturedPayload: any = null;

		const context: Context = {
			systemPrompt: "Simple string prompt",
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};

		const { streamAnthropic } = await import("../src/providers/anthropic.js");

		try {
			const s = streamAnthropic(model, context, {
				apiKey: "fake-key",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});
			for await (const event of s) {
				if (event.type === "error") break;
			}
		} catch {
			// Expected
		}

		expect(capturedPayload).not.toBeNull();
		// String is normalized to single block
		expect(capturedPayload.system).toHaveLength(1);
		expect(capturedPayload.system[0].text).toBe("Simple string prompt");
		expect(capturedPayload.system[0].cache_control).toEqual({ type: "ephemeral" });
	});

	it("should omit all cache_control when cacheRetention is none", async () => {
		const model = getModel("anthropic", "claude-3-5-haiku-20241022");
		let capturedPayload: any = null;

		const blocks: SystemPromptBlock[] = [{ text: "Block 1" }, { text: "Block 2" }];

		const context: Context = {
			systemPrompt: blocks,
			messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
		};

		const { streamAnthropic } = await import("../src/providers/anthropic.js");

		try {
			const s = streamAnthropic(model, context, {
				apiKey: "fake-key",
				cacheRetention: "none",
				onPayload: (payload) => {
					capturedPayload = payload;
				},
			});
			for await (const event of s) {
				if (event.type === "error") break;
			}
		} catch {
			// Expected
		}

		expect(capturedPayload).not.toBeNull();
		expect(capturedPayload.system).toHaveLength(2);
		expect(capturedPayload.system[0].cache_control).toBeUndefined();
		expect(capturedPayload.system[1].cache_control).toBeUndefined();
	});
});

describe("System Prompt Blocks — DPS Composer", () => {
	it("should split entries into stable and volatile blocks", async () => {
		const { PromptComposer } = await import("../../coding-agent/src/core/features/dps/prompt-composer.js");
		const composer = new PromptComposer();

		const entries = [
			{
				id: "core-tone",
				layer: 0 as const,
				priority: 0,
				content: "Be helpful.",
				programmatic: false,
				dynamic: false,
			},
			{
				id: "core-tools",
				layer: 0 as const,
				priority: 10,
				content: "Tools: read, write",
				programmatic: false,
				dynamic: false,
			},
			{
				id: "task-context",
				layer: 2 as const,
				priority: 1,
				content: "Task #1: Do something",
				programmatic: false,
				dynamic: true,
			},
			{
				id: "cwd-datetime",
				layer: 3 as const,
				priority: 99,
				content: "Date: Mon Mar 9",
				programmatic: false,
				dynamic: true,
			},
		];

		const result = composer.compose(entries, 0);

		// Should produce 2 blocks: stable (core-tone + core-tools) and volatile (task + datetime)
		expect(result.blocks).toHaveLength(2);
		expect(result.blocks[0].text).toBe("Be helpful.\n\nTools: read, write");
		expect(result.blocks[0].cache).toBe(true);
		expect(result.blocks[1].text).toBe("Task #1: Do something\n\nDate: Mon Mar 9");
		expect(result.blocks[1].cache).toBe(true);

		// Text should be the full joined content
		expect(result.text).toBe("Be helpful.\n\nTools: read, write\n\nTask #1: Do something\n\nDate: Mon Mar 9");
	});

	it("should produce single block when all entries are stable", async () => {
		const { PromptComposer } = await import("../../coding-agent/src/core/features/dps/prompt-composer.js");
		const composer = new PromptComposer();

		const entries = [
			{
				id: "core-tone",
				layer: 0 as const,
				priority: 0,
				content: "Be helpful.",
				programmatic: false,
				dynamic: false,
			},
			{
				id: "core-tools",
				layer: 0 as const,
				priority: 10,
				content: "Tools: read",
				programmatic: false,
				dynamic: false,
			},
		];

		const result = composer.compose(entries, 0);
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0].text).toBe("Be helpful.\n\nTools: read");
	});

	it("should produce single block when all entries are volatile", async () => {
		const { PromptComposer } = await import("../../coding-agent/src/core/features/dps/prompt-composer.js");
		const composer = new PromptComposer();

		const entries = [
			{ id: "cwd", layer: 3 as const, priority: 99, content: "CWD: /tmp", programmatic: false, dynamic: true },
		];

		const result = composer.compose(entries, 0);
		expect(result.blocks).toHaveLength(1);
		expect(result.blocks[0].text).toBe("CWD: /tmp");
	});
});
