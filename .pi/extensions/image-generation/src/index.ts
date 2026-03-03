/**
 * Image Generation Extension (Nano Banana / Gemini Image)
 *
 * Generates and edits images via Google's Gemini image models (Nano Banana).
 * Images are displayed inline via renderResult (details only, not sent to LLM).
 * Requires GEMINI_API_KEY environment variable.
 *
 * Models:
 *   gemini-3.1-flash-image-preview  (Nano Banana 2) — Fast, best price/quality (default)
 *   gemini-3-pro-image-preview      (Nano Banana Pro) — Highest quality, 4K
 *   gemini-2.5-flash-image          (Nano Banana v1) — Fastest, cheapest, max 1K
 *
 * Usage:
 *   "Generate a pixel art fireball sprite and save it to assets/fireball.png"
 *   "Edit this image to remove the background" (with image_path)
 *
 * Environment variables:
 *   GEMINI_API_KEY       — Required. Google AI API key.
 *   PI_IMAGE_MODEL       — Default model override.
 */

import { GoogleGenAI } from "@google/genai";
import { StringEnum } from "@mariozechner/pi-ai";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Container, Image, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const MODELS = [
	"gemini-3.1-flash-image-preview",
	"gemini-3-pro-image-preview",
	"gemini-2.5-flash-image",
] as const;

const ASPECT_RATIOS = [
	"1:1", "1:4", "1:8", "2:3", "3:2", "3:4",
	"4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9",
] as const;

const IMAGE_SIZES = ["512px", "1K", "2K", "4K"] as const;

const DEFAULT_MODEL = "gemini-3.1-flash-image-preview";
const DEFAULT_ASPECT_RATIO = "1:1";
const DEFAULT_IMAGE_SIZE = "1K";

const COST_PER_IMAGE: Record<string, string> = {
	"gemini-3.1-flash-image-preview": "~$0.067",
	"gemini-3-pro-image-preview": "~$0.134",
	"gemini-2.5-flash-image": "~$0.039",
};

function getClient(): GoogleGenAI {
	const apiKey = process.env.GEMINI_API_KEY;
	if (!apiKey) {
		throw new Error("GEMINI_API_KEY environment variable is not set. Get one at https://aistudio.google.com/apikey");
	}
	return new GoogleGenAI({ apiKey });
}

function mimeTypeFromFormat(format: string): string {
	switch (format) {
		case "jpeg": return "image/jpeg";
		case "webp": return "image/webp";
		default: return "image/png";
	}
}

// Shared renderResult for both tools — shows image from details
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
		savedPath?: string;
		outputPath?: string;
		model?: string;
		aspectRatio?: string;
		imageSize?: string;
		cost?: string;
	} | undefined;

	const container = new Container();

	// Summary line
	const textContent = result.content.find(c => c.type === "text")?.text || "Done";
	container.addChild(new Text(theme.fg("success", textContent), 0, 0));

	// Render image inline from details (NOT sent to LLM)
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
	// ── generate_image ──────────────────────────────────────────────────
	pi.registerTool({
		name: "generate_image",
		label: "Generate Image",
		description:
			"Generate an image from a text prompt using Google Gemini image models (Nano Banana). " +
			"Can save to a file path. Supports various aspect ratios and up to 4K resolution. " +
			"Models: gemini-3.1-flash-image-preview (default, fast), gemini-3-pro-image-preview (highest quality), " +
			"gemini-2.5-flash-image (cheapest). Requires GEMINI_API_KEY.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Image description / generation prompt." }),
			output_path: Type.Optional(Type.String({
				description: "File path to save the generated image (e.g., assets/hero.png). If omitted, image is returned but not saved.",
			})),
			model: Type.Optional(StringEnum(MODELS)),
			aspect_ratio: Type.Optional(StringEnum(ASPECT_RATIOS)),
			size: Type.Optional(StringEnum(IMAGE_SIZES)),
		}),

		renderCall(args, theme) {
			const model = args.model || process.env.PI_IMAGE_MODEL || DEFAULT_MODEL;
			const cost = COST_PER_IMAGE[model] || "";
			let text = theme.fg("toolTitle", theme.bold("generate_image "));
			text += theme.fg("accent", model);
			if (args.aspect_ratio) text += theme.fg("dim", ` ${args.aspect_ratio}`);
			if (args.size) text += theme.fg("dim", ` ${args.size}`);
			if (cost) text += theme.fg("dim", ` ${cost}`);
			if (args.output_path) text += theme.fg("dim", ` → ${args.output_path}`);
			text += "\n" + theme.fg("muted", `"${args.prompt}"`);
			return new Text(text, 0, 0);
		},

		renderResult: renderImageResult,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = params.model || process.env.PI_IMAGE_MODEL || DEFAULT_MODEL;
			const aspectRatio = params.aspect_ratio || DEFAULT_ASPECT_RATIO;
			const imageSize = params.size || DEFAULT_IMAGE_SIZE;
			const cost = COST_PER_IMAGE[model] || "unknown";

			onUpdate?.({
				content: [{ type: "text", text: `Generating image with ${model} (${aspectRatio}, ${imageSize})... [${cost}/image]` }],
				details: { model, aspectRatio, imageSize, status: "generating" },
			});

			const ai = getClient();
			const response = await ai.models.generateContent({
				model,
				contents: params.prompt,
				config: {
					responseModalities: ["TEXT", "IMAGE"],
					imageConfig: {
						aspectRatio,
						imageSize,
					},
				},
			});

			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Image generation cancelled." }] };
			}

			// Extract image and text from response
			let imageData: string | undefined;
			let imageMimeType = "image/png";
			const textParts: string[] = [];

			const parts = response.candidates?.[0]?.content?.parts;
			if (parts) {
				for (const part of parts) {
					if (part.text) {
						textParts.push(part.text);
					}
					if (part.inlineData?.data) {
						imageData = part.inlineData.data;
						imageMimeType = part.inlineData.mimeType || "image/png";
					}
				}
			}

			if (!imageData) {
				const errorText = textParts.length > 0 ? textParts.join(" ") : "Unknown error";
				return {
					content: [{ type: "text", text: `Image generation failed: ${errorText}` }],
					isError: true,
				};
			}

			// Save to file if output_path provided
			let savedPath: string | undefined;
			if (params.output_path) {
				const fullPath = resolve(ctx.cwd, params.output_path);
				await mkdir(dirname(fullPath), { recursive: true });
				await writeFile(fullPath, Buffer.from(imageData, "base64"));
				savedPath = params.output_path;
			}

			// Build text-only summary (this is what LLM sees)
			const summary: string[] = [];
			summary.push(`Generated image with ${model} (${aspectRatio}, ${imageSize}).`);
			if (savedPath) {
				summary.push(`Saved to: ${savedPath}`);
			}
			if (textParts.length > 0) {
				summary.push(`Model notes: ${textParts.join(" ")}`);
			}

			// content = text only (sent to LLM)
			// details = includes image data (for renderResult display only, NOT sent to LLM)
			return {
				content: [
					{ type: "text", text: summary.join(" ") },
				],
				details: { model, aspectRatio, imageSize, savedPath, cost, imageData, imageMimeType },
			};
		},
	});

	// ── edit_image ───────────────────────────────────────────────────────
	pi.registerTool({
		name: "edit_image",
		label: "Edit Image",
		description:
			"Edit an existing image using a text prompt. Supports modifications, style changes, " +
			"inpainting, background removal, and more. Can use up to 14 reference images. " +
			"Requires GEMINI_API_KEY.",
		parameters: Type.Object({
			prompt: Type.String({ description: "Edit instruction (e.g., 'remove the background', 'make it pixel art style')." }),
			image_path: Type.String({ description: "Path to the source image to edit." }),
			output_path: Type.Optional(Type.String({
				description: "File path to save the edited image. If omitted, overwrites the source.",
			})),
			reference_images: Type.Optional(Type.Array(Type.String(), {
				description: "Additional reference image paths for style/character consistency (max 14 total).",
			})),
			model: Type.Optional(StringEnum(MODELS)),
			aspect_ratio: Type.Optional(StringEnum(ASPECT_RATIOS)),
			size: Type.Optional(StringEnum(IMAGE_SIZES)),
		}),

		renderCall(args, theme) {
			const model = args.model || process.env.PI_IMAGE_MODEL || DEFAULT_MODEL;
			let text = theme.fg("toolTitle", theme.bold("edit_image "));
			text += theme.fg("accent", model);
			text += theme.fg("dim", ` ${args.image_path}`);
			if (args.output_path) text += theme.fg("dim", ` → ${args.output_path}`);
			if (args.reference_images?.length) text += theme.fg("dim", ` +${args.reference_images.length} refs`);
			text += "\n" + theme.fg("muted", `"${args.prompt}"`);
			return new Text(text, 0, 0);
		},

		renderResult: renderImageResult,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const model = params.model || process.env.PI_IMAGE_MODEL || DEFAULT_MODEL;
			const aspectRatio = params.aspect_ratio;
			const imageSize = params.size || DEFAULT_IMAGE_SIZE;

			onUpdate?.({
				content: [{ type: "text", text: `Editing image with ${model}...` }],
				details: { model, status: "editing" },
			});

			// Read source image
			const srcPath = resolve(ctx.cwd, params.image_path);
			const srcBuffer = await readFile(srcPath);
			const srcBase64 = srcBuffer.toString("base64");

			// Detect mime type from extension
			const ext = params.image_path.split(".").pop()?.toLowerCase() || "png";
			const srcMime = mimeTypeFromFormat(ext === "jpg" ? "jpeg" : ext);

			// Build content parts: prompt + source image + reference images
			const contentParts: Array<{ text: string } | { inlineData: { mimeType: string; data: string } }> = [];
			contentParts.push({ text: params.prompt });
			contentParts.push({ inlineData: { mimeType: srcMime, data: srcBase64 } });

			// Add reference images if provided
			if (params.reference_images) {
				for (const refPath of params.reference_images.slice(0, 13)) {
					const refFullPath = resolve(ctx.cwd, refPath);
					const refBuffer = await readFile(refFullPath);
					const refExt = refPath.split(".").pop()?.toLowerCase() || "png";
					const refMime = mimeTypeFromFormat(refExt === "jpg" ? "jpeg" : refExt);
					contentParts.push({ inlineData: { mimeType: refMime, data: refBuffer.toString("base64") } });
				}
			}

			const ai = getClient();
			const config: Record<string, unknown> = {
				responseModalities: ["TEXT", "IMAGE"],
				imageConfig: {
					imageSize,
					...(aspectRatio ? { aspectRatio } : {}),
				},
			};

			const response = await ai.models.generateContent({
				model,
				contents: contentParts,
				config: config as import("@google/genai").GenerateContentConfig,
			});

			if (signal?.aborted) {
				return { content: [{ type: "text", text: "Image editing cancelled." }] };
			}

			// Extract result
			let imageData: string | undefined;
			let imageMimeType = "image/png";
			const textParts: string[] = [];

			const parts = response.candidates?.[0]?.content?.parts;
			if (parts) {
				for (const part of parts) {
					if (part.text) textParts.push(part.text);
					if (part.inlineData?.data) {
						imageData = part.inlineData.data;
						imageMimeType = part.inlineData.mimeType || "image/png";
					}
				}
			}

			if (!imageData) {
				const errorText = textParts.length > 0 ? textParts.join(" ") : "Unknown error";
				return {
					content: [{ type: "text", text: `Image editing failed: ${errorText}` }],
					isError: true,
				};
			}

			// Save
			const outPath = params.output_path || params.image_path;
			const fullOutPath = resolve(ctx.cwd, outPath);
			await mkdir(dirname(fullOutPath), { recursive: true });
			await writeFile(fullOutPath, Buffer.from(imageData, "base64"));

			const summary: string[] = [];
			summary.push(`Edited image with ${model}.`);
			summary.push(`Saved to: ${outPath}`);
			if (textParts.length > 0) {
				summary.push(`Model notes: ${textParts.join(" ")}`);
			}

			// content = text only (sent to LLM)
			// details = includes image data (for renderResult display only, NOT sent to LLM)
			return {
				content: [
					{ type: "text", text: summary.join(" ") },
				],
				details: { model, outputPath: outPath, sourceImage: params.image_path, imageData, imageMimeType },
			};
		},
	});
}
