/**
 * Built-in image markers feature.
 *
 * Replaces raw clipboard image paths with clean [Image #N] markers in the editor.
 * On send, embeds images as base64 for the LLM and persists them as content-addressed
 * files in /tmp/pi-images/. Shows a clickable widget below the editor with OSC 8 links.
 *
 * Call registerImageMarkers(pi) once during extension setup (interactive mode only).
 */

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { EditorTheme, TUI } from "@mariozechner/pi-tui";
import { CustomEditor } from "../../modes/interactive/components/custom-editor.js";
import type { ExtensionAPI, ExtensionContext } from "../extensions/types.js";
import type { KeybindingsManager } from "../keybindings.js";

// ─── Data Types ───────────────────────────────────────────────────────────────

interface ImageEntry {
	/** Original temp file path from clipboard handler. */
	path: string;
	/** Extracted filename from the path. */
	filename: string;
	/** MIME type, e.g. "image/png". */
	mimeType: string;
}

// ─── Module-level state ───────────────────────────────────────────────────────

const images = new Map<number, ImageEntry>();
let counter = 0;

// ─── Detection ────────────────────────────────────────────────────────────────

/** Matches Pi's clipboard handler output: /tmp/pi-clipboard-<UUID>.<ext> */
const PI_CLIPBOARD_REGEX = /^\s*\/?.*\/pi-clipboard-[a-f0-9-]+\.(png|jpe?g|gif|webp)\s*$/i;

const MIME_MAP: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

function getMimeType(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() ?? "png";
	return MIME_MAP[ext] ?? "image/png";
}

// ─── State management ─────────────────────────────────────────────────────────

function clearImages(): void {
	images.clear();
	counter = 0;
}

// ─── Content-addressed persistence ───────────────────────────────────────────

function getImageStorageDir(): string {
	const dir = path.join(os.tmpdir(), "pi-images");
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

/**
 * Copy source image to /tmp/pi-images/img-<md5-12chars>.<ext>.
 * Deduplicates by content hash. Returns the persisted path, or sourcePath on error.
 */
function persistImage(sourcePath: string, mimeType: string): string {
	const dir = getImageStorageDir();
	const ext = Object.entries(MIME_MAP).find(([, v]) => v === mimeType)?.[0] ?? "png";

	try {
		const buffer = fs.readFileSync(sourcePath);
		const hash = crypto.createHash("md5").update(buffer).digest("hex").slice(0, 12);
		const filename = `img-${hash}.${ext}`;
		const destPath = path.join(dir, filename);

		if (!fs.existsSync(destPath)) {
			fs.writeFileSync(destPath, buffer);
		}

		return destPath;
	} catch {
		return sourcePath;
	}
}

// ─── ImageMarkerEditor ────────────────────────────────────────────────────────

class ImageMarkerEditor extends CustomEditor {
	private _widgetUpdater: (() => void) | null = null;

	constructor(tui: TUI, theme: EditorTheme, keybindings: KeybindingsManager) {
		super(tui, theme, keybindings);

		// Property descriptor trick: intercept onChange to call _syncImagesToText
		// after the original handler, so deleted markers are removed from tracking.
		let originalOnChange: ((text: string) => void) | undefined;
		const self = this;

		Object.defineProperty(this, "onChange", {
			get(): ((text: string) => void) | undefined {
				if (!originalOnChange) return undefined;
				return (text: string) => {
					originalOnChange!(text);
					if (images.size > 0 && text.length > 0) {
						self._syncImagesToText(text);
					}
				};
			},
			set(fn: ((text: string) => void) | undefined) {
				originalOnChange = fn;
			},
			configurable: true,
			enumerable: true,
		});
	}

	/** Register the widget updater callback to call after image state changes. */
	setWidgetUpdater(fn: () => void): void {
		this._widgetUpdater = fn;
	}

	/**
	 * Intercept clipboard image paths and replace with [Image #N] markers.
	 * All other text passes through to the parent implementation.
	 */
	insertTextAtCursor(text: string): void {
		const trimmed = text.trim();

		if (PI_CLIPBOARD_REGEX.test(trimmed)) {
			counter++;
			const id = counter;
			const filename = trimmed.split("/").pop() ?? trimmed;
			const mimeType = getMimeType(trimmed);
			images.set(id, { path: trimmed, filename, mimeType });

			super.insertTextAtCursor(`[Image #${id}]`);
			this._widgetUpdater?.();
			return;
		}

		super.insertTextAtCursor(text);
	}

	/** Expand [Image #N] markers back to original file paths (for internal use). */
	getExpandedText(): string {
		let text = super.getExpandedText();
		for (const [id, entry] of images) {
			text = text.replaceAll(`[Image #${id}]`, entry.path);
		}
		return text;
	}

	/**
	 * Remove tracked images whose [Image #N] marker no longer appears in text.
	 * Resets counter to 0 when all images are removed.
	 */
	_syncImagesToText(text: string): void {
		let changed = false;

		for (const [id] of images) {
			if (!text.includes(`[Image #${id}]`)) {
				images.delete(id);
				changed = true;
			}
		}

		if (images.size === 0) {
			counter = 0;
		}

		if (changed) {
			this._widgetUpdater?.();
		}
	}
}

// ─── Registration ─────────────────────────────────────────────────────────────

/**
 * Register the image markers feature via the extension API.
 *
 * Hooks:
 * - session_start: replace editor with ImageMarkerEditor, clear state
 * - session_before_switch: clear images, hide widget
 * - session_shutdown: cleanup
 * - input: embed images as base64, transform markers to markdown links
 *
 * Usage:
 *   extensionRunner.registerBuiltinExtension("<builtin-image-markers>", registerImageMarkers)
 */
export function registerImageMarkers(pi: ExtensionAPI): void {
	let sessionCtx: ExtensionContext | null = null;

	// ─── Widget below editor ─────────────────────────────────────────────────

	function updateWidget(): void {
		if (!sessionCtx) return;

		if (images.size === 0) {
			sessionCtx.ui.setWidget("image-markers", undefined);
			return;
		}

		sessionCtx.ui.setWidget(
			"image-markers",
			(_tui, theme) => {
				const labels: string[] = [];

				for (const [id, entry] of images) {
					const url = `file://${entry.path}`;
					const osc8Start = `\x1b]8;;${url}\x07`;
					const osc8End = `\x1b]8;;\x07`;
					const styledLabel = theme.fg("accent", `[Image #${id}]`);
					labels.push(`${osc8Start}${styledLabel}${osc8End}`);
				}

				const line = `📎 ${labels.join("  ")}  ${theme.fg("dim", "(⌘+Click to open)")}`;

				return {
					render: () => [line],
					invalidate: () => {},
				};
			},
			{ placement: "belowEditor" },
		);
	}

	// ─── Session lifecycle ───────────────────────────────────────────────────

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		clearImages();

		ctx.ui.setEditorComponent((tui, theme, kb) => {
			const editor = new ImageMarkerEditor(tui, theme, kb);
			editor.setWidgetUpdater(updateWidget);
			return editor;
		});
	});

	pi.on("session_before_switch", async () => {
		clearImages();
		updateWidget();
	});

	pi.on("session_shutdown", async () => {
		clearImages();
		sessionCtx = null;
	});

	// ─── Input: embed images + make markers clickable markdown links ─────────

	pi.on("input", async (event, _ctx) => {
		if (images.size === 0) return { action: "continue" as const };

		let text = event.text;
		const imageContents: ImageContent[] = [];
		const matchedIds: number[] = [];

		for (const [id, entry] of images) {
			const marker = `[Image #${id}]`;
			if (text.includes(marker)) {
				matchedIds.push(id);

				try {
					const buffer = fs.readFileSync(entry.path);
					const base64 = buffer.toString("base64");
					imageContents.push({ type: "image", data: base64, mimeType: entry.mimeType });

					// Persist and replace marker with clickable markdown link
					const persistedPath = persistImage(entry.path, entry.mimeType);
					text = text.replaceAll(marker, `[Image #${id}](file://${persistedPath})`);
				} catch {
					// Graceful degradation: replace marker with raw path
					text = text.replaceAll(marker, entry.path);
				}
			}
		}

		if (matchedIds.length > 0) {
			const allImages: ImageContent[] = [...(event.images ?? []), ...imageContents];

			clearImages();
			updateWidget();

			return {
				action: "transform" as const,
				text: text || "Describe this image.",
				images: allImages,
			};
		}

		return { action: "continue" as const };
	});
}
