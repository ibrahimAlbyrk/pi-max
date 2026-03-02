/**
 * File Browser Extension
 *
 * Browse, search, and select files from the project directory without leaving Pi.
 * Press Ctrl+Shift+F to open the file browser overlay.
 * Select files with Space, insert @references with Enter, copy with C.
 *
 * Also available via /browse command.
 */

import { readdirSync, statSync } from "node:fs"
import { basename, dirname, join, relative } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent"
import { DynamicBorder } from "@mariozechner/pi-coding-agent"
import {
	Container,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@mariozechner/pi-tui"

// ─── Types ───────────────────────────────────────────────────────────────────

interface FileEntry {
	name: string
	fullPath: string
	relativePath: string
	isDirectory: boolean
	size: number
}

interface BrowseResult {
	action: "editor" | "clipboard"
	paths: string[]
}

// ─── File Operations ─────────────────────────────────────────────────────────

function loadEntries(dirPath: string, cwd: string, showHidden: boolean): FileEntry[] {
	try {
		const dirents = readdirSync(dirPath, { withFileTypes: true })
		const entries: FileEntry[] = dirents
			.filter((d) => showHidden || !d.name.startsWith("."))
			.filter((d) => d.name !== "node_modules" && d.name !== ".git")
			.map((d) => {
				const fullPath = join(dirPath, d.name)
				const relativePath = relative(cwd, fullPath)
				let size = 0
				try {
					if (d.isFile()) size = statSync(fullPath).size
				} catch {}
				return {
					name: d.name,
					fullPath,
					relativePath,
					isDirectory: d.isDirectory(),
					size,
				}
			})
			.sort((a, b) => {
				if (a.isDirectory && !b.isDirectory) return -1
				if (!a.isDirectory && b.isDirectory) return 1
				return a.name.localeCompare(b.name)
			})

		// Parent directory entry
		if (dirPath !== cwd) {
			entries.unshift({
				name: "..",
				fullPath: dirname(dirPath),
				relativePath: "..",
				isDirectory: true,
				size: 0,
			})
		}

		return entries
	} catch {
		return []
	}
}

function formatSize(bytes: number): string {
	if (bytes === 0) return ""
	if (bytes < 1024) return `${bytes} B`
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ─── File Browser Overlay ────────────────────────────────────────────────────

async function openFileBrowser(
	ctx: ExtensionContext,
	pi: ExtensionAPI,
	startPath?: string,
): Promise<BrowseResult | null> {
	return ctx.ui.custom<BrowseResult | null>(
		(tui, theme, _kb, done) => {
			// ── State ──
			let currentPath = startPath || ctx.cwd
			let entries = loadEntries(currentPath, ctx.cwd, false)
			let highlightedIndex = 0
			let scrollOffset = 0
			let selectedPaths = new Set<string>()
			let showHidden = false
			let searchMode = false
			let searchQuery = ""
			let searchResults: FileEntry[] = []
			const maxVisible = 16

			// ── Helpers ──
			function currentItems(): FileEntry[] {
				return searchMode ? searchResults : entries
			}

			function adjustScroll() {
				const items = currentItems()
				if (highlightedIndex < scrollOffset) {
					scrollOffset = highlightedIndex
				} else if (highlightedIndex >= scrollOffset + maxVisible) {
					scrollOffset = highlightedIndex - maxVisible + 1
				}
				if (scrollOffset < 0) scrollOffset = 0
				if (items.length <= maxVisible) scrollOffset = 0
			}

			function reload() {
				entries = loadEntries(currentPath, ctx.cwd, showHidden)
				highlightedIndex = 0
				scrollOffset = 0
			}

			function doSearch() {
				if (!searchQuery) {
					searchResults = []
					highlightedIndex = 0
					scrollOffset = 0
					return
				}
				const q = searchQuery.toLowerCase()
				// Simple recursive search through current entries
				// For deeper search, we'd use fd
				const results: FileEntry[] = []
				function searchDir(dirPath: string, depth: number) {
					if (depth > 5 || results.length >= 100) return
					try {
						const dirents = readdirSync(dirPath, { withFileTypes: true })
						for (const d of dirents) {
							if (results.length >= 100) break
							if (d.name.startsWith(".") || d.name === "node_modules" || d.name === ".git") continue
							const fullPath = join(dirPath, d.name)
							const relativePath = relative(ctx.cwd, fullPath)
							if (d.isFile() && (d.name.toLowerCase().includes(q) || relativePath.toLowerCase().includes(q))) {
								let size = 0
								try { size = statSync(fullPath).size } catch {}
								results.push({
									name: d.name,
									fullPath,
									relativePath,
									isDirectory: false,
									size,
								})
							}
							if (d.isDirectory()) {
								// Also check if dir name matches
								if (d.name.toLowerCase().includes(q)) {
									results.push({
										name: d.name,
										fullPath,
										relativePath,
										isDirectory: true,
										size: 0,
									})
								}
								searchDir(fullPath, depth + 1)
							}
						}
					} catch {}
				}
				searchDir(ctx.cwd, 0)
				searchResults = results
				highlightedIndex = 0
				scrollOffset = 0
			}

			// ── Component ──
			return {
				render(width: number): string[] {
					const lines: string[] = []
					const items = currentItems()
					const selectedCount = selectedPaths.size

					// ── Top border ──
					const borderChar = "─"
					const titleText = " File Browser "
					const titleLen = visibleWidth(titleText)
					const sideLen = Math.max(1, Math.floor((width - titleLen) / 2))
					const topBorder = theme.fg("accent", borderChar.repeat(sideLen) + titleText + borderChar.repeat(Math.max(1, width - sideLen - titleLen)))
					lines.push(truncateToWidth(topBorder, width))

					// ── Search bar or breadcrumb ──
					if (searchMode) {
						const searchPrefix = theme.fg("accent", " 🔍 ")
						const cursor = theme.fg("dim", "█")
						const queryText = theme.bold(searchQuery)
						const countStr = selectedCount > 0 ? theme.fg("success", `  ${selectedCount} selected`) : ""
						lines.push(truncateToWidth(searchPrefix + queryText + cursor + countStr, width))
					} else {
						const relDir = relative(ctx.cwd, currentPath) || "."
						const breadcrumb = theme.fg("dim", ` 📂 ${relDir}/`)
						const countStr = selectedCount > 0 ? theme.fg("success", `  ${selectedCount} selected`) : ""
						const bcWidth = visibleWidth(breadcrumb)
						const cntWidth = visibleWidth(countStr)
						const pad = Math.max(1, width - bcWidth - cntWidth)
						lines.push(truncateToWidth(breadcrumb + " ".repeat(pad) + countStr, width))
					}

					// ── Separator ──
					lines.push(theme.fg("dim", "─".repeat(width)))

					// ── File list ──
					if (items.length === 0) {
						const emptyMsg = searchMode ? " No results" : " Empty directory"
						lines.push(theme.fg("muted", emptyMsg))
						// Pad to maxVisible
						for (let i = 1; i < maxVisible; i++) lines.push("")
					} else {
						const visible = Math.min(maxVisible, items.length)
						for (let i = scrollOffset; i < Math.min(scrollOffset + visible, items.length); i++) {
							const entry = items[i]
							const isHighlighted = i === highlightedIndex
							const isSelected = selectedPaths.has(entry.relativePath)

							// Checkbox
							let checkbox: string
							if (entry.isDirectory) {
								checkbox = "  "
							} else {
								checkbox = isSelected ? "☑ " : "☐ "
							}

							// Icon
							const icon = entry.isDirectory ? "📂 " : "📄 "

							// Name
							let name = entry.name
							if (entry.isDirectory && entry.name !== "..") name += "/"
							if (searchMode && !entry.isDirectory) {
								name = entry.relativePath
							}

							// Size
							const size = entry.isDirectory ? "" : formatSize(entry.size)

							// Compose line
							let left = ` ${checkbox}${icon}${name}`
							const sizeStr = size ? theme.fg("dim", size) : ""
							const leftWidth = visibleWidth(left)
							const sizeWidth = visibleWidth(sizeStr)
							const gap = Math.max(1, width - leftWidth - sizeWidth - 1)
							let line = left + " ".repeat(gap) + sizeStr

							// Style based on state
							if (isHighlighted && isSelected) {
								line = theme.bg("selectedBg", theme.fg("accent", truncateToWidth(line, width)))
							} else if (isHighlighted) {
								line = theme.bg("selectedBg", theme.fg("text", truncateToWidth(line, width)))
							} else if (isSelected) {
								line = theme.fg("accent", truncateToWidth(line, width))
							} else {
								line = truncateToWidth(line, width)
							}

							lines.push(line)
						}

						// Pad remaining visible lines
						for (let i = items.length - scrollOffset; i < maxVisible; i++) {
							if (i >= 0) lines.push("")
						}
					}

					// ── Scroll indicator ──
					if (items.length > maxVisible) {
						const pct = Math.round(((scrollOffset + maxVisible) / items.length) * 100)
						lines.push(theme.fg("dim", ` ↕ ${Math.min(pct, 100)}% (${items.length} items)`))
					} else {
						lines.push(theme.fg("dim", ` ${items.length} items`))
					}

					// ── Bottom border ──
					lines.push(theme.fg("dim", "─".repeat(width)))

					// ── Shortcuts ──
					let shortcuts: string
					if (searchMode) {
						shortcuts = theme.fg("dim", " type to search • esc:back • enter:select • space:toggle")
					} else {
						shortcuts = theme.fg("dim", " ↑↓:nav • enter:open/add • space:select • c:copy • /:search • esc:close")
					}
					lines.push(truncateToWidth(shortcuts, width))

					return lines
				},

				handleInput(data: string) {
					const items = currentItems()

					// ── Search mode ──
					if (searchMode) {
						if (matchesKey(data, Key.escape)) {
							searchMode = false
							searchQuery = ""
							searchResults = []
							highlightedIndex = 0
							scrollOffset = 0
						} else if (matchesKey(data, Key.backspace)) {
							if (searchQuery.length > 0) {
								searchQuery = searchQuery.slice(0, -1)
								if (searchQuery.length === 0) {
									searchMode = false
									searchResults = []
									highlightedIndex = 0
									scrollOffset = 0
								} else {
									doSearch()
								}
							} else {
								searchMode = false
								searchResults = []
							}
						} else if (matchesKey(data, Key.up)) {
							if (highlightedIndex > 0) highlightedIndex--
							adjustScroll()
						} else if (matchesKey(data, Key.down)) {
							if (highlightedIndex < items.length - 1) highlightedIndex++
							adjustScroll()
						} else if (matchesKey(data, Key.enter)) {
							const entry = items[highlightedIndex]
							if (entry) {
								if (entry.isDirectory) {
									// Navigate into directory, exit search
									currentPath = entry.fullPath
									searchMode = false
									searchQuery = ""
									searchResults = []
									reload()
								} else if (selectedPaths.size > 0) {
									done({ action: "editor", paths: [...selectedPaths] })
									return
								} else {
									done({ action: "editor", paths: [entry.relativePath] })
									return
								}
							}
						} else if (matchesKey(data, "space")) {
							const entry = items[highlightedIndex]
							if (entry && !entry.isDirectory) {
								if (selectedPaths.has(entry.relativePath)) {
									selectedPaths.delete(entry.relativePath)
								} else {
									selectedPaths.add(entry.relativePath)
								}
							}
						} else if (data.length === 1 && data.charCodeAt(0) >= 32) {
							searchQuery += data
							doSearch()
						}

						tui.requestRender()
						return
					}

					// ── Normal mode ──
					if (matchesKey(data, Key.escape)) {
						done(null)
						return
					}

					if (matchesKey(data, Key.up)) {
						if (highlightedIndex > 0) highlightedIndex--
						adjustScroll()
					} else if (matchesKey(data, Key.down)) {
						if (highlightedIndex < items.length - 1) highlightedIndex++
						adjustScroll()
					} else if (matchesKey(data, Key.enter)) {
						const entry = items[highlightedIndex]
						if (entry?.isDirectory) {
							currentPath = entry.fullPath
							reload()
						} else if (selectedPaths.size > 0) {
							done({ action: "editor", paths: [...selectedPaths] })
							return
						} else if (entry) {
							done({ action: "editor", paths: [entry.relativePath] })
							return
						}
					} else if (matchesKey(data, Key.backspace)) {
						if (currentPath !== ctx.cwd) {
							currentPath = dirname(currentPath)
							reload()
						}
					} else if (matchesKey(data, "space")) {
						const entry = items[highlightedIndex]
						if (entry && !entry.isDirectory && entry.name !== "..") {
							if (selectedPaths.has(entry.relativePath)) {
								selectedPaths.delete(entry.relativePath)
							} else {
								selectedPaths.add(entry.relativePath)
							}
						}
					} else if (matchesKey(data, "c") || matchesKey(data, "C")) {
						if (selectedPaths.size > 0) {
							done({ action: "clipboard", paths: [...selectedPaths] })
							return
						}
						// If no selection, copy highlighted file
						const entry = items[highlightedIndex]
						if (entry && !entry.isDirectory) {
							done({ action: "clipboard", paths: [entry.relativePath] })
							return
						}
					} else if (matchesKey(data, "a") || matchesKey(data, "A")) {
						const files = items.filter((e) => !e.isDirectory && e.name !== "..")
						if (files.length > 0 && selectedPaths.size === files.length) {
							selectedPaths.clear()
						} else {
							for (const f of files) selectedPaths.add(f.relativePath)
						}
					} else if (matchesKey(data, "/")) {
						searchMode = true
						searchQuery = ""
						highlightedIndex = 0
						scrollOffset = 0
					} else if (matchesKey(data, "h") || matchesKey(data, "H")) {
						showHidden = !showHidden
						reload()
					} else if (matchesKey(data, "r") || matchesKey(data, "R")) {
						reload()
					}

					tui.requestRender()
				},

				invalidate() {
					// No-op: we rebuild on every render
				},
			}
		},
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "80%",
				maxHeight: "80%",
			},
		},
	)
}

// ─── Clipboard Helper ────────────────────────────────────────────────────────

async function writeClipboard(pi: ExtensionAPI, text: string): Promise<boolean> {
	try {
		// Try pbcopy (macOS)
		const result = await pi.exec("bash", ["-c", `printf '%s' ${JSON.stringify(text)} | pbcopy`], { timeout: 3000 })
		if (result.code === 0) return true
	} catch {}
	try {
		// Try xclip (Linux)
		const result = await pi.exec("bash", ["-c", `printf '%s' ${JSON.stringify(text)} | xclip -selection clipboard`], { timeout: 3000 })
		if (result.code === 0) return true
	} catch {}
	try {
		// Try xsel (Linux)
		const result = await pi.exec("bash", ["-c", `printf '%s' ${JSON.stringify(text)} | xsel --clipboard --input`], { timeout: 3000 })
		if (result.code === 0) return true
	} catch {}
	return false
}

// ─── Result Handler ──────────────────────────────────────────────────────────

async function handleResult(result: BrowseResult | null, ctx: ExtensionContext, pi: ExtensionAPI): Promise<void> {
	if (!result || result.paths.length === 0) return

	const refText = result.paths.map((p) => `@${p}`).join(" ")

	if (result.action === "editor") {
		ctx.ui.pasteToEditor(refText + " ")
		ctx.ui.notify(`${result.paths.length} file ref(s) added to editor`, "info")
		// Force render
		ctx.ui.setStatus("_fb", " ")
		ctx.ui.setStatus("_fb", undefined)
	} else if (result.action === "clipboard") {
		const ok = await writeClipboard(pi, refText)
		if (ok) {
			ctx.ui.notify(`${result.paths.length} file ref(s) copied — paste with Ctrl+V`, "info")
		} else {
			// Fallback: put in editor
			ctx.ui.pasteToEditor(refText + " ")
			ctx.ui.notify(`Clipboard unavailable — added to editor instead`, "warning")
		}
	}
}

// ─── Extension Entry Point ───────────────────────────────────────────────────

export default function (pi: ExtensionAPI) {
	// Keyboard shortcut
	pi.registerShortcut(Key.alt("o"), {
		description: "Open file browser",
		handler: async (ctx) => {
			if (!ctx.hasUI) return
			const result = await openFileBrowser(ctx, pi)
			await handleResult(result, ctx, pi)
		},
	})

	// Slash command
	pi.registerCommand("browse", {
		description: "Browse and select files from the project",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("No UI available", "error")
				return
			}
			const result = await openFileBrowser(ctx, pi)
			await handleResult(result, ctx, pi)
		},
	})
}
