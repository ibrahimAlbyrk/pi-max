/**
 * Image Markers Extension
 *
 * Replaces raw image file paths with clean [Image #N] markers when pasting images.
 * - Ctrl+V paste: shows [Image #1], [Image #2], etc. instead of long temp file paths
 * - Widget below editor: shows attached images with Cmd+Click to open
 * - Input transform: reads image files and embeds them directly into the user message
 *   as base64 image content, so LLM sees images immediately without needing read tool
 * - [Image #N] markers become clickable OSC 8 links (⌘+Click) in the user message
 * - Images are persisted to /tmp/pi-images/ for automatic cleanup
 */

import { CustomEditor, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as crypto from "node:crypto";

// ─── Shared state ────────────────────────────────────────────────────────────

interface ImageEntry {
	path: string;
	filename: string;
	mimeType: string;
}

let images = new Map<number, ImageEntry>();
let counter = 0;

function clearImages() {
	images.clear();
	counter = 0;
}

// Regex to match Pi's clipboard image temp files
const PI_CLIPBOARD_REGEX = /^\s*\/?.*\/pi-clipboard-[a-f0-9-]+\.(png|jpe?g|gif|webp)\s*$/i;

const MIME_MAP: Record<string, string> = {
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	gif: "image/gif",
	webp: "image/webp",
};

function getMimeType(filePath: string): string {
	const ext = filePath.split(".").pop()?.toLowerCase() || "png";
	return MIME_MAP[ext] || "image/png";
}

function getImageStorageDir(): string {
	const dir = path.join(os.tmpdir(), "pi-images");
	if (!fs.existsSync(dir)) {
		fs.mkdirSync(dir, { recursive: true });
	}
	return dir;
}

function persistImage(sourcePath: string, mimeType: string): string {
	const dir = getImageStorageDir();
	const ext = Object.entries(MIME_MAP).find(([, v]) => v === mimeType)?.[0] || "png";

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

// ─── Custom Editor ───────────────────────────────────────────────────────────

class ImageMarkerEditor extends CustomEditor {
	private _widgetUpdater: (() => void) | null = null;

	constructor(tui: any, theme: any, kb: any) {
		super(tui, theme, kb);

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

	_syncImagesToText(text: string) {
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

	setWidgetUpdater(fn: () => void) {
		this._widgetUpdater = fn;
	}

	insertTextAtCursor(text: string): void {
		const trimmed = text.trim();

		if (PI_CLIPBOARD_REGEX.test(trimmed)) {
			counter++;
			const id = counter;
			const filename = trimmed.split("/").pop() || trimmed;
			const mimeType = getMimeType(trimmed);
			images.set(id, { path: trimmed, filename, mimeType });

			super.insertTextAtCursor(`[Image #${id}]`);
			this._widgetUpdater?.();
			return;
		}

		super.insertTextAtCursor(text);
	}

	getExpandedText(): string {
		let text = super.getExpandedText();
		for (const [id, entry] of images) {
			text = text.replaceAll(`[Image #${id}]`, entry.path);
		}
		return text;
	}
}

// ─── Extension entry point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	let sessionCtx: any = null;

	// ─── Widget below editor ─────────────────────────────────────────────

	function updateWidget() {
		if (!sessionCtx) return;

		if (images.size === 0) {
			sessionCtx.ui.setWidget("image-markers", undefined);
			return;
		}

		sessionCtx.ui.setWidget(
			"image-markers",
			(_tui: any, theme: any) => {
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

	// ─── Input: embed images + make markers clickable markdown links ─────

	pi.on("input", async (event, _ctx) => {
		if (images.size === 0) return { action: "continue" as const };

		let text = event.text;
		const imageContents: Array<{ type: "image"; data: string; mimeType: string }> = [];
		const matchedIds: number[] = [];

		for (const [id, entry] of images) {
			const marker = `[Image #${id}]`;
			if (text.includes(marker)) {
				matchedIds.push(id);

				try {
					const buffer = fs.readFileSync(entry.path);
					const base64 = buffer.toString("base64");
					imageContents.push({
						type: "image",
						data: base64,
						mimeType: entry.mimeType,
					});

					// Persist image and replace marker with clickable markdown link
					const persistedPath = persistImage(entry.path, entry.mimeType);
					text = text.replaceAll(marker, `[Image #${id}](file://${persistedPath})`);
				} catch {
					text = text.replaceAll(marker, entry.path);
				}
			}
		}

		if (matchedIds.length > 0) {
			const allImages = [...(event.images || []), ...imageContents];

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

	// ─── Session lifecycle ───────────────────────────────────────────────

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
}
