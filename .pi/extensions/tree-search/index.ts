/**
 * Tree Search Extension
 *
 * Provides a `tree_search` tool for browsing and searching project files
 * with minimal token usage. Agent navigates layer by layer (depth) or
 * searches with fuzzy/regex queries. Respects .gitignore.
 *
 * Usage:
 *   tree_search(depth=1)                          → top-level dirs/files
 *   tree_search(path="src", depth=1)              → src/ contents
 *   tree_search(path="src", depth=1, type="dir")  → only subdirs
 *   tree_search(query="input system")             → fuzzy search
 *   tree_search(query="/auth.*middleware/")        → regex search
 */

import { StringEnum, Type } from "@mariozechner/pi-ai";
import type { ExtensionAPI, Theme } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { readdirSync, readFileSync, existsSync, statSync, realpathSync, watch, type FSWatcher } from "node:fs";
import { join, relative, resolve, sep, basename, dirname } from "node:path";
import ignore, { type Ignore } from "ignore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TreeNode {
	name: string;
	/** Path relative to project root */
	relativePath: string;
	isDir: boolean;
	children?: TreeNode[];
	/** Recursive file count (dirs only) */
	fileCount?: number;
	/** Immediate subdirectory count (dirs only) */
	dirCount?: number;
}

interface TreeSearchConfig {
	include?: string[];
	exclude?: string[];
}

interface SearchResult {
	path: string;
	score: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALWAYS_EXCLUDE = [".git", "node_modules"];
const CACHE_TTL = 30_000;
const DEBOUNCE_MS = 300;
const SCAN_MAX_DEPTH = 20;

const BROWSE_DEFAULT_LIMIT = 100;
const BROWSE_MAX_LIMIT = 500;
const SEARCH_DEFAULT_LIMIT = 50;
const SEARCH_MAX_LIMIT = 200;

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

function loadGitignore(dir: string): Ignore {
	const ig = ignore();
	ig.add(ALWAYS_EXCLUDE);

	// Walk up from dir to find .gitignore files (root first)
	const gitignores: string[] = [];
	let current = dir;
	while (true) {
		const gitignorePath = join(current, ".gitignore");
		if (existsSync(gitignorePath)) {
			gitignores.unshift(gitignorePath);
		}
		const parent = dirname(current);
		if (parent === current) break;
		current = parent;
	}

	for (const filePath of gitignores) {
		try {
			const content = readFileSync(filePath, "utf-8");
			const rootDir = dirname(filePath);
			const relPrefix = relative(dir, rootDir);

			const lines = content.split(/\r?\n/);
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("#")) continue;

				if (relPrefix) {
					// Prefix patterns from nested gitignores
					let pattern = trimmed;
					let negated = false;
					if (pattern.startsWith("!")) {
						negated = true;
						pattern = pattern.slice(1);
					}
					if (pattern.startsWith("/")) {
						pattern = pattern.slice(1);
					}
					const prefixed = `${relPrefix.split(sep).join("/")}/${pattern}`;
					ig.add(negated ? `!${prefixed}` : prefixed);
				} else {
					ig.add(trimmed);
				}
			}
		} catch {
			// Skip unreadable gitignore
		}
	}

	return ig;
}

function loadConfig(cwd: string): TreeSearchConfig {
	const configPath = join(cwd, ".pi", "tree-search.json");
	if (!existsSync(configPath)) return {};
	try {
		const content = readFileSync(configPath, "utf-8");
		return JSON.parse(content) as TreeSearchConfig;
	} catch {
		return {};
	}
}

function matchesGlob(name: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		// Simple glob: *.ext or exact match
		if (pattern.startsWith("*.")) {
			if (name.endsWith(pattern.slice(1))) return true;
		} else if (pattern.includes("*")) {
			const regex = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
			if (regex.test(name)) return true;
		} else {
			if (name === pattern) return true;
		}
	}
	return false;
}

function scanDirectory(
	dir: string,
	rootDir: string,
	ig: Ignore,
	config: TreeSearchConfig,
	visited: Set<string>,
	currentDepth: number,
): TreeNode[] {
	if (currentDepth > SCAN_MAX_DEPTH) return [];

	let entries: ReturnType<typeof readdirSync>;
	try {
		entries = readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}

	const nodes: TreeNode[] = [];

	for (const entry of entries) {
		if (entry.name.startsWith(".") && ALWAYS_EXCLUDE.includes(entry.name)) continue;

		const fullPath = join(dir, entry.name);
		const relPath = relative(rootDir, fullPath).split(sep).join("/");

		let isDir = entry.isDirectory();
		let isFile = entry.isFile();

		if (entry.isSymbolicLink()) {
			try {
				const real = realpathSync(fullPath);
				if (visited.has(real)) continue; // Circular ref
				visited.add(real);
				const stats = statSync(fullPath);
				isDir = stats.isDirectory();
				isFile = stats.isFile();
			} catch {
				continue; // Broken symlink
			}
		}

		// Check gitignore
		const ignorePath = isDir ? `${relPath}/` : relPath;
		if (ig.ignores(ignorePath)) continue;

		// Check config exclude
		if (config.exclude && matchesGlob(entry.name, config.exclude)) continue;
		if (isDir && config.exclude) {
			const dirPattern = `${entry.name}/`;
			if (config.exclude.some((p) => p === dirPattern || p === entry.name)) continue;
		}

		if (isDir) {
			const children = scanDirectory(fullPath, rootDir, ig, config, visited, currentDepth + 1);

			// Count files and dirs
			let fileCount = 0;
			let dirCount = 0;
			const countRecursive = (nodes: TreeNode[]) => {
				for (const node of nodes) {
					if (node.isDir) {
						dirCount++;
						if (node.children) countRecursive(node.children);
					} else {
						fileCount++;
					}
				}
			};
			// dirCount should be immediate children only
			dirCount = children.filter((c) => c.isDir).length;
			fileCount = 0;
			const countFiles = (nodes: TreeNode[]) => {
				for (const node of nodes) {
					if (node.isDir) {
						if (node.children) countFiles(node.children);
					} else {
						fileCount++;
					}
				}
			};
			countFiles(children);

			// Apply include filter: keep dir if it has any matching descendants
			if (config.include && config.include.length > 0) {
				if (fileCount === 0 && children.length === 0) continue;
			}

			nodes.push({
				name: entry.name,
				relativePath: relPath,
				isDir: true,
				children,
				fileCount,
				dirCount,
			});
		} else if (isFile) {
			// Check config include
			if (config.include && config.include.length > 0) {
				if (!matchesGlob(entry.name, config.include)) continue;
			}

			nodes.push({
				name: entry.name,
				relativePath: relPath,
				isDir: false,
			});
		}
	}

	// Sort: directories first, then alphabetical
	nodes.sort((a, b) => {
		if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return nodes;
}

function scanProject(cwd: string): TreeNode[] {
	const ig = loadGitignore(cwd);
	const config = loadConfig(cwd);
	const visited = new Set<string>();

	try {
		visited.add(realpathSync(cwd));
	} catch {
		// Ignore
	}

	return scanDirectory(cwd, cwd, ig, config, visited, 0);
}

// ---------------------------------------------------------------------------
// Browse
// ---------------------------------------------------------------------------

function findSubtree(nodes: TreeNode[], targetPath: string): { nodes: TreeNode[] } | { error: "not_found" | "not_a_directory" } {
	const parts = targetPath.split("/").filter(Boolean);

	let current = nodes;
	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];

		// Check if it matches a file (not a directory)
		const fileMatch = current.find((n) => n.name === part && !n.isDir);
		if (fileMatch) {
			return { error: "not_a_directory" };
		}

		const found = current.find((n) => n.name === part && n.isDir);
		if (!found || !found.children) return { error: "not_found" };
		current = found.children;
	}

	return { nodes: current };
}

function renderBrowse(
	nodes: TreeNode[],
	path: string | undefined,
	depth: number,
	type: "file" | "dir" | undefined,
	offset: number,
	limit: number,
): string {
	const entries: string[] = [];

	const collect = (nodes: TreeNode[], currentDepth: number, indent: string) => {
		if (currentDepth > depth) return;

		for (const node of nodes) {
			if (node.isDir) {
				// Always traverse into directories regardless of type filter
				const showDir = type !== "file";
				if (showDir) {
					let line = `${indent}${node.name}/`;
					const meta: string[] = [];
					if (node.fileCount !== undefined && node.fileCount > 0) {
						meta.push(`${node.fileCount} files`);
					}
					if (node.dirCount !== undefined && node.dirCount > 0) {
						meta.push(`${node.dirCount} dirs`);
					}
					if (meta.length > 0) {
						line += `  (${meta.join(", ")})`;
					}
					entries.push(line);
				}

				// Recurse regardless of type filter so files in subdirs are reachable
				if (currentDepth < depth && node.children) {
					collect(node.children, currentDepth + 1, showDir ? indent + "  " : indent);
				}
			} else {
				if (type !== "dir") {
					entries.push(`${indent}${node.name}`);
				}
			}
		}
	};

	collect(nodes, 1, path ? "  " : "");

	const total = entries.length;

	const lines: string[] = [];
	if (path) {
		lines.push(`${path}/`);
	}

	if (offset >= total && total > 0) {
		lines.push("");
		lines.push(`No more results. Total: ${total} entries.`);
	} else if (total > 0) {
		const paginated = entries.slice(offset, offset + limit);
		lines.push(...paginated);

		const from = offset + 1;
		const to = Math.min(offset + limit, total);
		lines.push("");
		if (total > limit || offset > 0) {
			lines.push(`Showing ${from}-${to} of ${total} entries.${to < total ? ` Use offset=${to} to see more.` : ""}`);
		} else {
			lines.push(`${total} entries.`);
		}
	} else {
		lines.push("No entries found.");
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function collectAllPaths(nodes: TreeNode[]): { path: string; isDir: boolean; depth: number }[] {
	const results: { path: string; isDir: boolean; depth: number }[] = [];

	const walk = (nodes: TreeNode[], depth: number) => {
		for (const node of nodes) {
			results.push({ path: node.relativePath, isDir: node.isDir, depth });
			if (node.isDir && node.children) {
				walk(node.children, depth + 1);
			}
		}
	};

	walk(nodes, 0);
	return results;
}

function fuzzySearch(
	allPaths: { path: string; isDir: boolean; depth: number }[],
	query: string,
	type: "file" | "dir" | undefined,
): SearchResult[] {
	const keywords = query
		.toLowerCase()
		.split(/\s+/)
		.filter((k) => k.length > 0);
	if (keywords.length === 0) return [];

	const results: SearchResult[] = [];

	for (const entry of allPaths) {
		if (type === "file" && entry.isDir) continue;
		if (type === "dir" && !entry.isDir) continue;

		const pathLower = entry.path.toLowerCase();
		let matchCount = 0;

		for (const keyword of keywords) {
			if (pathLower.includes(keyword)) {
				matchCount++;
			}
		}

		if (matchCount === 0) continue;

		// Score: matched keywords (higher = better) - depth penalty (shallower = better)
		const score = matchCount * 100 - entry.depth;

		results.push({ path: entry.isDir ? `${entry.path}/` : entry.path, score });
	}

	results.sort((a, b) => b.score - a.score);
	return results;
}

function regexSearch(
	allPaths: { path: string; isDir: boolean; depth: number }[],
	pattern: string,
	type: "file" | "dir" | undefined,
): SearchResult[] {
	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "i");
	} catch {
		return [];
	}

	const results: SearchResult[] = [];

	for (const entry of allPaths) {
		if (type === "file" && entry.isDir) continue;
		if (type === "dir" && !entry.isDir) continue;

		if (regex.test(entry.path)) {
			const score = 100 - entry.depth;
			results.push({ path: entry.isDir ? `${entry.path}/` : entry.path, score });
		}
	}

	results.sort((a, b) => b.score - a.score);
	return results;
}

function renderSearch(
	results: SearchResult[],
	query: string,
	isRegex: boolean,
	offset: number,
	limit: number,
): string {
	const total = results.length;
	const queryLabel = isRegex ? `regex ${query}` : `"${query}"`;

	const lines: string[] = [];

	if (offset >= total && total > 0) {
		lines.push(`No more results. Total: ${total} matches for ${queryLabel}.`);
	} else if (total > 0) {
		const paginated = results.slice(offset, offset + limit);
		for (const r of paginated) {
			lines.push(r.path);
		}

		const from = offset + 1;
		const to = Math.min(offset + limit, total);
		lines.push("");
		if (total > limit || offset > 0) {
			lines.push(
				`Showing ${from}-${to} of ${total} matches for ${queryLabel}.${to < total ? ` Use offset=${to} to see more.` : ""}`,
			);
		} else {
			lines.push(`${total} matches for ${queryLabel}.`);
		}
	} else {
		lines.push(`No matches for ${queryLabel}.`);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	let cwd: string;
	let cache: TreeNode[] | null = null;
	let dirty = true;
	let cacheTime = 0;
	let watcher: FSWatcher | null = null;
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	function invalidateCache() {
		if (debounceTimer) clearTimeout(debounceTimer);
		debounceTimer = setTimeout(() => {
			dirty = true;
		}, DEBOUNCE_MS);
	}

	function getTree(): TreeNode[] {
		const now = Date.now();
		if (dirty || !cache || now - cacheTime > CACHE_TTL) {
			cache = scanProject(cwd);
			cacheTime = now;
			dirty = false;
		}
		return cache;
	}

	function startWatcher() {
		try {
			watcher = watch(cwd, { recursive: true }, () => {
				invalidateCache();
			});
			watcher.on("error", () => {
				// Watcher failed, TTL fallback will handle it
				watcher = null;
			});
		} catch {
			// fs.watch not supported or failed, rely on TTL
		}
	}

	// Initialize on session start
	pi.on("session_start", async (_event, ctx) => {
		cwd = ctx.cwd;
		startWatcher();
	});

	// Cleanup on shutdown
	pi.on("session_shutdown", async () => {
		if (watcher) {
			watcher.close();
			watcher = null;
		}
		if (debounceTimer) {
			clearTimeout(debounceTimer);
		}
	});

	// Register the tool
	pi.registerTool({
		name: "tree_search",
		label: "Tree Search",
		description:
			"Browse and search project files with minimal token usage. Navigate layer by layer with depth, or search with fuzzy/regex query. Respects .gitignore.\n\n" +
			"Browse mode (no query): Use path + depth to explore directories incrementally.\n" +
			"Search mode (with query): Fuzzy match by default. Wrap in /pattern/ for regex.\n\n" +
			"Examples:\n" +
			'  tree_search()                              → top-level overview\n' +
			'  tree_search(path="src", depth=1)           → src/ contents\n' +
			'  tree_search(path="src", type="dir")        → only subdirectories\n' +
			'  tree_search(query="input system")          → fuzzy search\n' +
			'  tree_search(query="/auth.*middleware/")     → regex search\n' +
			'  tree_search(query="config", offset=50)     → paginate results',
		parameters: Type.Object({
			path: Type.Optional(
				Type.String({
					description: "Subtree root to browse from (relative to project root). Default: project root.",
				}),
			),
			depth: Type.Optional(
				Type.Number({
					description: "How many levels deep to show. Default: 1.",
				}),
			),
			query: Type.Optional(
				Type.String({
					description: "Search query. Fuzzy match on full paths by default. Wrap in /pattern/ for regex.",
				}),
			),
			type: Type.Optional(
				StringEnum(["file", "dir"] as const, {
					description: "Filter: 'file' for files only, 'dir' for directories only.",
				}),
			),
			offset: Type.Optional(
				Type.Number({
					description: "Skip first N results for pagination. Default: 0.",
				}),
			),
			limit: Type.Optional(
				Type.Number({
					description: `Max results to return. Default: ${BROWSE_DEFAULT_LIMIT} (browse) or ${SEARCH_DEFAULT_LIMIT} (search).`,
				}),
			),
		}),

		renderCall(args, theme) {
			let text = theme.fg("toolTitle", theme.bold("tree_search "));

			if (args.query) {
				const isRegex = args.query.startsWith("/") && args.query.endsWith("/");
				text += theme.fg("warning", isRegex ? "regex " : "search ");
				text += theme.fg("accent", `"${args.query}"`);
			} else {
				text += theme.fg("muted", "browse ");
				if (args.path) text += theme.fg("accent", args.path);
				else text += theme.fg("dim", ".");
				if (args.depth) text += theme.fg("dim", ` depth=${args.depth}`);
			}

			if (args.type) text += theme.fg("dim", ` type=${args.type}`);
			if (args.offset) text += theme.fg("dim", ` offset=${args.offset}`);
			if (args.limit) text += theme.fg("dim", ` limit=${args.limit}`);

			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			const details = result.details as Record<string, unknown> | undefined;
			const content = result.content[0];
			const rawText = content?.type === "text" ? content.text : "";

			if (details?.error) {
				return new Text(theme.fg("error", rawText), 0, 0);
			}

			const lines = rawText.split("\n");
			const rendered: string[] = [];

			for (const line of lines) {
				if (!line) {
					rendered.push("");
					continue;
				}

				// Pagination info line
				if (line.startsWith("Showing ") || line.startsWith("No ") || line.match(/^\d+ (entries|matches)/)) {
					rendered.push(theme.fg("dim", line));
					continue;
				}

				// Directory line (ends with / or has file/dir count)
				if (line.match(/\/\s*(\(|$)/)) {
					const match = line.match(/^(\s*)(.*?\/)\s*(\(.*\))?$/);
					if (match) {
						const indent = match[1] || "";
						const dirName = match[2];
						const meta = match[3] || "";
						rendered.push(indent + theme.fg("accent", dirName) + (meta ? " " + theme.fg("dim", meta) : ""));
						continue;
					}
				}

				// Search result (full path)
				if (details?.mode === "search") {
					if (line.endsWith("/")) {
						rendered.push(theme.fg("accent", line));
					} else {
						const lastSlash = line.lastIndexOf("/");
						if (lastSlash >= 0) {
							rendered.push(theme.fg("dim", line.slice(0, lastSlash + 1)) + theme.fg("text", line.slice(lastSlash + 1)));
						} else {
							rendered.push(theme.fg("text", line));
						}
					}
					continue;
				}

				// File line
				const fileMatch = line.match(/^(\s*)(.*)/);
				if (fileMatch) {
					rendered.push((fileMatch[1] || "") + theme.fg("text", fileMatch[2]));
				} else {
					rendered.push(line);
				}
			}

			if (!expanded && rendered.length > 20) {
				const truncated = rendered.slice(0, 20);
				truncated.push(theme.fg("dim", `... ${rendered.length - 20} more lines`));
				return new Text(truncated.join("\n"), 0, 0);
			}

			return new Text(rendered.join("\n"), 0, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			// Use ctx.cwd if available, fallback to stored cwd
			const effectiveCwd = ctx?.cwd ?? cwd;
			if (effectiveCwd && effectiveCwd !== cwd) {
				cwd = effectiveCwd;
				dirty = true;
			}

			// --- Input normalization ---
			const normalizePath = (p: string | undefined): string | undefined => {
				if (!p) return undefined;
				let normalized = p
					.replace(/^@/, "")   // Strip leading @ (some models add it)
					.replace(/^\.\//, "") // Strip leading ./
					.replace(/\/+$/, ""); // Strip trailing slash(es)
				if (normalized === "." || normalized === "") return undefined;
				return normalized;
			};

			const tree = getTree();
			const offset = Math.max(0, params.offset ?? 0);
			const type = params.type as "file" | "dir" | undefined;
			const path = normalizePath(params.path);

			if (params.query) {
				// Search mode
				const limit = Math.max(1, Math.min(params.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT));
				const query = params.query.trim();

				// If path is specified, search within that subtree only
				let searchTree = tree;
				if (path) {
					const result = findSubtree(tree, path);
					if ("error" in result) {
						const msg = result.error === "not_a_directory"
							? `Not a directory: ${path}. Use read tool for file contents.`
							: `Path not found: ${path}`;
						return {
							content: [{ type: "text", text: msg }],
							details: { mode: "search", error: result.error },
						};
					}
					searchTree = result.nodes;
				}

				const isRegex = query.startsWith("/") && query.endsWith("/") && query.length > 2;
				const allPaths = collectAllPaths(searchTree);

				let results: SearchResult[];
				if (isRegex) {
					const pattern = query.slice(1, -1);
					results = regexSearch(allPaths, pattern, type);
				} else {
					results = fuzzySearch(allPaths, query, type);
				}

				const output = renderSearch(results, isRegex ? query.slice(1, -1) : query, isRegex, offset, limit);

				return {
					content: [{ type: "text", text: output }],
					details: { mode: "search", query, path, total: results.length, offset, limit },
				};
			} else {
				// Browse mode
				const limit = Math.max(1, Math.min(params.limit ?? BROWSE_DEFAULT_LIMIT, BROWSE_MAX_LIMIT));
				const depth = params.depth ?? 1;

				let subtree: TreeNode[];
				if (path) {
					const result = findSubtree(tree, path);
					if ("error" in result) {
						const msg = result.error === "not_a_directory"
							? `Not a directory: ${path}. Use read tool for file contents.`
							: `Path not found: ${path}`;
						return {
							content: [{ type: "text", text: msg }],
							details: { mode: "browse", error: result.error },
						};
					}
					subtree = result.nodes;
				} else {
					subtree = tree;
				}

				const output = renderBrowse(subtree, path, depth, type, offset, limit);

				return {
					content: [{ type: "text", text: output }],
					details: { mode: "browse", path: path ?? ".", depth, total: subtree.length, offset, limit },
				};
			}
		},
	});
}
