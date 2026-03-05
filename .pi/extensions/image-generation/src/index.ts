/**
 * Image Generation Extension — Multi-Provider
 *
 * Generates and edits images using multiple AI providers.
 * Images are displayed inline via renderResult (details only, not sent to LLM).
 *
 * Providers (auto-detected from env vars):
 *   gemini    — Nano Banana (GEMINI_API_KEY)
 *   openai    — gpt-image-1 (OPENAI_API_KEY)
 *   flux      — FLUX Pro via fal.ai (FAL_KEY)
 *   stability — Stable Diffusion 3 (STABILITY_API_KEY)
 *
 * Budget config (JSON):
 *   Global:  ~/.pi/agent/extensions/image-generation.json
 *   Project: <project>/.pi/extensions/image-generation.json
 *   Fields:  { "budgetLimit": 20, "budgetWarning": 15 }
 */

import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Image, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { BudgetTracker } from "./budget.js";
import { PROVIDER_NAMES, resolveProvider } from "./resolver.js";
import { mimeTypeFromExtension } from "./utils.js";

const ASPECT_RATIOS = [
	"1:1", "1:4", "1:8", "2:3", "3:2", "3:4",
	"4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9",
] as const;

const IMAGE_SIZES = ["512px", "1K", "2K", "4K"] as const;

const budget = new BudgetTracker();

// Shared renderResult — shows image + budget status from details (not sent to LLM)
function renderImageResult(
	result: { content: Array<{ type: string; text?: string }>; details?: Record<string, unknown>; isError?: boolean },
	options: { expanded: boolean; isPartial: boolean },
	theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
) {
	if (options.isPartial) {
		return new Text(theme.fg("warning", "Generating..."), 0, 0);
	}

	if (result.isError) {
		const text = result.content.find(c => c.type === "text")?.text || "Error";
		return new Text(theme.fg("error", text), 0, 0);
	}

	const details = result.details as {
		imageData?: string;
		imageMimeType?: string;
		cost?: number;
		budgetStatus?: string;
		budgetWarning?: boolean;
	} | undefined;

	const container = new Container();

	const textContent = result.content.find(c => c.type === "text")?.text || "Done";
	container.addChild(new Text(theme.fg("success", textContent), 0, 0));

	// Budget info line
	if (details?.cost !== undefined) {
		const costStr = `$${details.cost.toFixed(3)}`;
		const budgetLine = details.budgetStatus
			? `Cost: ${costStr} | ${details.budgetStatus}`
			: `Cost: ${costStr}`;
		const color = details.budgetWarning ? "warning" : "dim";
		container.addChild(new Text(theme.fg(color, budgetLine), 0, 0));
	}

	if (details?.imageData) {
		container.addChild(new Image(
			details.imageData,
			details.imageMimeType || "image/png",
			{ fallbackColor: (s: string) => theme.fg("dim", s) },
			{ maxWidthCells: 60, maxHeightCells: 30 },
		));
	}

	return container;
}

export default function imageGeneration(pi: ExtensionAPI) {
	// ── Initialize budget on session start ───────────────────────────────
	pi.on("session_start", async (_event, ctx) => {
		budget.loadConfig(ctx.cwd);
		budget.setPersist((customType, data) => pi.appendEntry(customType, data));

		const entries = ctx.sessionManager.getEntries();
		budget.loadFromEntries(entries as Array<{ type: string; customType?: string; data?: unknown }>);
	});

	// ── generate_image ──────────────────────────────────────────────────
	pi.registerTool({
		name: "generate_image",
		label: "Generate Image",
		description:
			"Generate an image from a text prompt. " +
			"Providers: gemini (Nano Banana), openai (gpt-image-1), flux (FLUX Pro), stability (SD3). " +
			"Auto-detects provider from available API keys, or specify with provider param. " +
			"Supports various aspect ratios. Always saves to the specified output_path.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Image description / generation prompt." }),
			output_path: Type.String({
				description: "File path to save the generated image (e.g., assets/hero.png). REQUIRED.",
			}),
			provider: Type.Optional(StringEnum(PROVIDER_NAMES as unknown as readonly [string, ...string[]])),
			aspect_ratio: Type.Optional(StringEnum(ASPECT_RATIOS)),
			size: Type.Optional(StringEnum(IMAGE_SIZES)),
		}),

		renderCall(args, _options, theme) {
			let providerName: string;
			try {
				providerName = resolveProvider(args.provider).name;
			} catch {
				providerName = args.provider || "auto";
			}
			let text = theme.fg("toolTitle", theme.bold("generate_image "));
			text += theme.fg("accent", providerName);
			if (args.aspect_ratio) text += theme.fg("dim", ` ${args.aspect_ratio}`);
			if (args.size) text += theme.fg("dim", ` ${args.size}`);
			if (args.output_path) text += theme.fg("dim", ` → ${args.output_path}`);
			text += "\n" + theme.fg("muted", `"${args.prompt}"`);
			return new Text(text, 0, 0);
		},

		renderResult: renderImageResult,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Budget check
			const budgetError = budget.check();
			if (budgetError) {
				return { content: [{ type: "text", text: budgetError }], isError: true };
			}

			const provider = resolveProvider(params.provider);

			onUpdate?.({
				content: [{ type: "text", text: `Generating image with ${provider.name}...` }],
				details: { provider: provider.name, status: "generating" },
			});

			const result = await provider.generate({
				prompt: params.prompt,
				aspectRatio: params.aspect_ratio,
				size: params.size,
				signal,
			});

			// Record cost
			const cost = provider.estimateCost({ size: params.size });
			const showWarning = budget.record(cost);

			// Save to file
			const fullPath = resolve(ctx.cwd, params.output_path);
			await mkdir(dirname(fullPath), { recursive: true });
			await writeFile(fullPath, Buffer.from(result.data, "base64"));
			const savedPath = params.output_path;

			const summary: string[] = [];
			summary.push(`Generated image with ${provider.name}. Saved to: ${savedPath}`);

			return {
				content: [{ type: "text", text: summary.join(" ") }],
				details: {
					provider: provider.name,
					savedPath,
					imageData: result.data,
					imageMimeType: result.mimeType,
					cost,
					budgetStatus: budget.getStatus(),
					budgetWarning: showWarning,
				},
			};
		},
	});

	// ── edit_image ───────────────────────────────────────────────────────
	pi.registerTool({
		name: "edit_image",
		label: "Edit Image",
		description:
			"Edit an existing image using a text prompt. Supports modifications, style changes, " +
			"inpainting, background removal. Can use reference images for consistency. " +
			"Not all providers support editing.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Edit instruction." }),
			image_path: Type.String({ description: "Path to the source image to edit." }),
			output_path: Type.Optional(Type.String({
				description: "File path to save the edited image. If omitted, overwrites the source.",
			})),
			reference_images: Type.Optional(Type.Array(Type.String(), {
				description: "Additional reference image paths (max 14 total).",
			})),
			provider: Type.Optional(StringEnum(PROVIDER_NAMES as unknown as readonly [string, ...string[]])),
			aspect_ratio: Type.Optional(StringEnum(ASPECT_RATIOS)),
			size: Type.Optional(StringEnum(IMAGE_SIZES)),
		}),

		renderCall(args, _options, theme) {
			let providerName: string;
			try {
				providerName = resolveProvider(args.provider).name;
			} catch {
				providerName = args.provider || "auto";
			}
			let text = theme.fg("toolTitle", theme.bold("edit_image "));
			text += theme.fg("accent", providerName);
			text += theme.fg("dim", ` ${args.image_path}`);
			if (args.output_path) text += theme.fg("dim", ` → ${args.output_path}`);
			if (args.reference_images?.length) text += theme.fg("dim", ` +${args.reference_images.length} refs`);
			text += "\n" + theme.fg("muted", `"${args.prompt}"`);
			return new Text(text, 0, 0);
		},

		renderResult: renderImageResult,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			// Budget check
			const budgetError = budget.check();
			if (budgetError) {
				return { content: [{ type: "text", text: budgetError }], isError: true };
			}

			const provider = resolveProvider(params.provider);

			if (!provider.edit) {
				return {
					content: [{ type: "text", text: `Provider "${provider.name}" does not support image editing.` }],
					isError: true,
				};
			}

			onUpdate?.({
				content: [{ type: "text", text: `Editing image with ${provider.name}...` }],
				details: { provider: provider.name, status: "editing" },
			});

			// Read source image
			const srcPath = resolve(ctx.cwd, params.image_path);
			const srcBuffer = await readFile(srcPath);
			const srcMime = mimeTypeFromExtension(params.image_path);

			// Read reference images
			const referenceImages: Array<{ data: string; mimeType: string }> = [];
			if (params.reference_images) {
				for (const refPath of params.reference_images.slice(0, 13)) {
					const refFullPath = resolve(ctx.cwd, refPath);
					const refBuffer = await readFile(refFullPath);
					referenceImages.push({
						data: refBuffer.toString("base64"),
						mimeType: mimeTypeFromExtension(refPath),
					});
				}
			}

			const result = await provider.edit({
				prompt: params.prompt,
				sourceImage: { data: srcBuffer.toString("base64"), mimeType: srcMime },
				referenceImages: referenceImages.length > 0 ? referenceImages : undefined,
				aspectRatio: params.aspect_ratio,
				size: params.size,
				signal,
			});

			// Record cost
			const cost = provider.estimateCost({ size: params.size });
			const showWarning = budget.record(cost);

			// Save
			const outPath = params.output_path || params.image_path;
			const fullOutPath = resolve(ctx.cwd, outPath);
			await mkdir(dirname(fullOutPath), { recursive: true });
			await writeFile(fullOutPath, Buffer.from(result.data, "base64"));

			const summary: string[] = [];
			summary.push(`Edited image with ${provider.name}.`);
			summary.push(`Saved to: ${outPath}`);

			return {
				content: [{ type: "text", text: summary.join(" ") }],
				details: {
					provider: provider.name,
					outputPath: outPath,
					sourceImage: params.image_path,
					imageData: result.data,
					imageMimeType: result.mimeType,
					cost,
					budgetStatus: budget.getStatus(),
					budgetWarning: showWarning,
				},
			};
		},
	});
}
