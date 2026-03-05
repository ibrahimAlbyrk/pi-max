/**
 * Search tool — unified file browsing, path search, and content search.
 *
 * Replaces find, grep, and ls tools with a single token-efficient tool.
 * Respects .gitignore. Uses flat path index with LRU browse cache.
 *
 * Three modes:
 *   - Browse mode (no query/content): Navigate directories incrementally by depth
 *   - Search mode (query param): Fuzzy (fzf-style) or regex search on file paths
 *   - Content mode (content param): Search file contents via ripgrep
 */

import { execFileSync } from "node:child_process";
import {
	type Dirent,
	existsSync,
	type FSWatcher,
	readdirSync,
	readFileSync,
	realpathSync,
	statSync,
	watch,
} from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import type { AgentTool } from "@mariozechner/pi-agent-core";
import { type Static, Type } from "@sinclair/typebox";
import ignore, { type Ignore } from "ignore";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Flat entry for the search index — minimal memory footprint */
interface PathEntry {
	/** Path relative to project root (forward slashes) */
	path: string;
	/** Whether this is a directory */
	isDir: boolean;
	/** Depth from project root (0 = top-level) */
	depth: number;
}

/** Browse cache entry for a single directory */
interface BrowseCacheEntry {
	/** Direct children: name, isDir, and for dirs: recursive fileCount + immediate dirCount */
	children: BrowseChild[];
	/** When this entry was cached */
	time: number;
}

interface BrowseChild {
	name: string;
	isDir: boolean;
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

interface ContentMatch {
	file: string;
	line: number;
	text: string;
}

export interface SearchToolDetails {
	mode?: string;
	error?: string;
	query?: string;
	path?: string;
	total?: number;
	offset?: number;
	limit?: number;
	depth?: number;
	engine?: string;
}

export type SearchToolInput = Static<typeof searchSchema>;

export interface SearchToolOptions {
	// Reserved for future Operations interface support
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
const CONTENT_DEFAULT_LIMIT = 50;
const CONTENT_MAX_LIMIT = 200;
const CONTENT_MAX_PER_FILE = 5;

/** Max entries in browse LRU cache */
const BROWSE_CACHE_MAX = 500;

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

const searchSchema = Type.Object({
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
	content: Type.Optional(
		Type.String({
			description:
				'Search file contents via ripgrep. Supports regex (e.g., "foo|bar", "handle.*Error"). Returns matching lines grouped by file.',
		}),
	),
	type: Type.Optional(
		Type.Union([Type.Literal("file"), Type.Literal("dir")], {
			description: "Filter: 'file' for files only, 'dir' for directories only.",
		}),
	),
	glob: Type.Optional(
		Type.String({
			description:
				'Filter files by glob pattern in content mode (e.g., "*.ts", "*.{js,tsx}"). Passed to ripgrep --glob.',
		}),
	),
	literal: Type.Optional(
		Type.Boolean({
			description: "Treat content pattern as literal string instead of regex (default: false).",
		}),
	),
	ignoreCase: Type.Optional(
		Type.Boolean({
			description: "Case-insensitive content search (default: false).",
		}),
	),
	context: Type.Optional(
		Type.Number({
			description: "Number of lines to show before and after each content match (default: 0).",
		}),
	),
	offset: Type.Optional(
		Type.Number({
			description: "Skip first N results for pagination. Default: 0.",
		}),
	),
	limit: Type.Optional(
		Type.Number({
			description: `Max results to return. Default: ${BROWSE_DEFAULT_LIMIT} (browse), ${SEARCH_DEFAULT_LIMIT} (search), ${CONTENT_DEFAULT_LIMIT} (content).`,
		}),
	),
});

// ---------------------------------------------------------------------------
// Gitignore & Config
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
	const configPath = join(cwd, ".pi", "search.json");
	if (!existsSync(configPath)) {
		// Backwards compat: check old name
		const oldPath = join(cwd, ".pi", "tree-search.json");
		if (!existsSync(oldPath)) return {};
		try {
			return JSON.parse(readFileSync(oldPath, "utf-8")) as TreeSearchConfig;
		} catch {
			return {};
		}
	}
	try {
		return JSON.parse(readFileSync(configPath, "utf-8")) as TreeSearchConfig;
	} catch {
		return {};
	}
}

function matchesGlob(name: string, patterns: string[]): boolean {
	for (const pattern of patterns) {
		if (pattern.startsWith("*.")) {
			if (name.endsWith(pattern.slice(1))) return true;
		} else if (pattern.includes("*")) {
			const regex = new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
			if (regex.test(name)) return true;
		} else {
			if (name === pattern) return true;
		}
	}
	return false;
}

// ---------------------------------------------------------------------------
// Flat Scanner — builds PathEntry[]
// ---------------------------------------------------------------------------

function scanFlat(
	dir: string,
	rootDir: string,
	ig: Ignore,
	config: TreeSearchConfig,
	visited: Set<string>,
	currentDepth: number,
	results: PathEntry[],
): void {
	if (currentDepth > SCAN_MAX_DEPTH) return;

	let entries: Dirent[];
	try {
		entries = readdirSync(dir, { withFileTypes: true, encoding: "utf-8" }) as Dirent[];
	} catch {
		return;
	}

	for (const entry of entries) {
		if (entry.name.startsWith(".") && ALWAYS_EXCLUDE.includes(entry.name)) continue;

		const fullPath = join(dir, entry.name);
		const relPath = relative(rootDir, fullPath).split(sep).join("/");

		let isDir = entry.isDirectory();
		let isFile = entry.isFile();

		if (entry.isSymbolicLink()) {
			try {
				const real = realpathSync(fullPath);
				if (visited.has(real)) continue;
				visited.add(real);
				const stats = statSync(fullPath);
				isDir = stats.isDirectory();
				isFile = stats.isFile();
			} catch {
				continue;
			}
		}

		const ignorePath = isDir ? `${relPath}/` : relPath;
		if (ig.ignores(ignorePath)) continue;

		if (config.exclude && matchesGlob(entry.name, config.exclude)) continue;
		if (isDir && config.exclude) {
			const dirPattern = `${entry.name}/`;
			if (config.exclude.some((p) => p === dirPattern || p === entry.name)) continue;
		}

		if (isDir) {
			results.push({ path: relPath, isDir: true, depth: currentDepth });
			const dirIndex = results.length - 1;

			scanFlat(fullPath, rootDir, ig, config, visited, currentDepth + 1, results);

			// If include filter active and no file descendants, remove this dir
			if (config.include && config.include.length > 0) {
				const hasFiles = results.slice(dirIndex + 1).some((e) => !e.isDir);
				if (!hasFiles) {
					results.splice(dirIndex, results.length - dirIndex);
				}
			}
		} else if (isFile) {
			if (config.include && config.include.length > 0) {
				if (!matchesGlob(entry.name, config.include)) continue;
			}
			results.push({ path: relPath, isDir: false, depth: currentDepth });
		}
	}
}

function scanProjectFlat(cwd: string): PathEntry[] {
	const ig = loadGitignore(cwd);
	const config = loadConfig(cwd);
	const visited = new Set<string>();

	try {
		visited.add(realpathSync(cwd));
	} catch {
		// Ignore
	}

	const results: PathEntry[] = [];
	scanFlat(cwd, cwd, ig, config, visited, 0, results);

	// Sort: directories first within each depth, then alphabetical
	results.sort((a, b) => {
		if (a.depth !== b.depth) return a.depth - b.depth;
		if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
		return a.path.localeCompare(b.path);
	});

	return results;
}

// ---------------------------------------------------------------------------
// LRU Browse Cache
// ---------------------------------------------------------------------------

class LRUBrowseCache {
	private cache = new Map<string, BrowseCacheEntry>();
	private maxSize: number;

	constructor(maxSize: number) {
		this.maxSize = maxSize;
	}

	get(key: string): BrowseCacheEntry | undefined {
		const entry = this.cache.get(key);
		if (entry) {
			this.cache.delete(key);
			this.cache.set(key, entry);
		}
		return entry;
	}

	set(key: string, value: BrowseCacheEntry): void {
		if (this.cache.has(key)) {
			this.cache.delete(key);
		} else if (this.cache.size >= this.maxSize) {
			const firstKey = this.cache.keys().next().value;
			if (firstKey !== undefined) {
				this.cache.delete(firstKey);
			}
		}
		this.cache.set(key, value);
	}

	clear(): void {
		this.cache.clear();
	}
}

function buildBrowseChildren(flatIndex: PathEntry[], dirPath: string): BrowseChild[] {
	const prefix = dirPath ? `${dirPath}/` : "";
	const prefixLen = prefix.length;

	const childMap = new Map<string, BrowseChild>();

	for (const entry of flatIndex) {
		if (!entry.path.startsWith(prefix)) continue;

		const rest = entry.path.slice(prefixLen);
		if (!rest) continue;

		const slashIndex = rest.indexOf("/");

		if (slashIndex === -1) {
			if (!childMap.has(rest)) {
				childMap.set(rest, {
					name: rest,
					isDir: entry.isDir,
					...(entry.isDir ? { fileCount: 0, dirCount: 0 } : {}),
				});
			}
		} else {
			const childDirName = rest.slice(0, slashIndex);
			let child = childMap.get(childDirName);
			if (!child) {
				child = { name: childDirName, isDir: true, fileCount: 0, dirCount: 0 };
				childMap.set(childDirName, child);
			}

			const nestedRest = rest.slice(slashIndex + 1);
			if (entry.isDir) {
				if (!nestedRest.includes("/")) {
					child.dirCount = (child.dirCount ?? 0) + 1;
				}
			} else {
				child.fileCount = (child.fileCount ?? 0) + 1;
			}
		}
	}

	const children = Array.from(childMap.values());
	children.sort((a, b) => {
		if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
		return a.name.localeCompare(b.name);
	});

	return children;
}

// ---------------------------------------------------------------------------
// Fuzzy Search
// ---------------------------------------------------------------------------

function fuzzyMatchScore(query: string, target: string): number {
	const q = query.toLowerCase();
	const t = target.toLowerCase();
	const qLen = q.length;
	const tLen = t.length;

	if (qLen === 0) return 0;
	if (qLen > tLen) return -1;

	// Quick check: does target contain all query chars in order?
	let qi = 0;
	for (let ti = 0; ti < tLen && qi < qLen; ti++) {
		if (t[ti] === q[qi]) qi++;
	}
	if (qi < qLen) return -1;

	let score = 0;
	let consecutive = 0;
	let lastMatchIdx = -2;

	// Prefer matching at word boundaries
	const boundaryIndices: number[] = [];
	for (let ti = 0; ti < tLen; ti++) {
		if (
			ti === 0 ||
			"/\\-_.".includes(t[ti - 1]) ||
			(ti > 0 && t[ti] !== target[ti] && t[ti - 1] === target[ti - 1])
		) {
			boundaryIndices.push(ti);
		}
	}

	// Try boundary-first matching
	let boundaryQi = 0;
	let boundaryScore = 0;
	let boundaryConsecutive = 0;
	let boundaryLastMatch = -2;

	for (const bi of boundaryIndices) {
		if (boundaryQi >= qLen) break;
		if (t[bi] === q[boundaryQi]) {
			boundaryQi++;
			boundaryScore += 10;

			if (bi === boundaryLastMatch + 1) {
				boundaryConsecutive++;
				boundaryScore += boundaryConsecutive * 3;
			} else {
				boundaryConsecutive = 0;
			}

			boundaryLastMatch = bi;
		}
	}

	if (boundaryQi < qLen) {
		// Fall back to pure greedy
		qi = 0;
		score = 0;
		consecutive = 0;
		lastMatchIdx = -2;

		for (let ti = 0; ti < tLen && qi < qLen; ti++) {
			if (t[ti] === q[qi]) {
				qi++;

				if (ti === 0 || "/\\-_.".includes(t[ti - 1])) {
					score += 10;
				}

				if (ti > 0 && t[ti] !== target[ti] && t[ti - 1] === target[ti - 1]) {
					score += 8;
				}

				if (ti === lastMatchIdx + 1) {
					consecutive++;
					score += consecutive * 3;
				} else {
					consecutive = 0;
				}

				score += Math.max(0, ((tLen - ti) / tLen) * 2);

				lastMatchIdx = ti;
			}
		}
	} else {
		score = boundaryScore;
	}

	// Basename bonus
	const lastSlash = target.lastIndexOf("/");
	const baseNameLower = (lastSlash >= 0 ? target.slice(lastSlash + 1) : target).toLowerCase();

	if (baseNameLower.includes(q)) {
		score += 25;
	} else {
		let bqi = 0;
		for (let bi = 0; bi < baseNameLower.length && bqi < qLen; bi++) {
			if (baseNameLower[bi] === q[bqi]) bqi++;
		}
		if (bqi === qLen) {
			score += 15;
		}
	}

	// Shorter path bonus
	score -= target.length * 0.1;

	// Shallower depth bonus
	const slashCount = (target.match(/\//g) || []).length;
	score -= slashCount * 2;

	return score;
}

function fuzzySearch(allPaths: PathEntry[], query: string, type: "file" | "dir" | undefined): SearchResult[] {
	const trimmed = query.trim();
	if (!trimmed) return [];

	const hasSpaces = trimmed.includes(" ");
	const results: SearchResult[] = [];

	if (hasSpaces) {
		const keywords = trimmed
			.toLowerCase()
			.split(/\s+/)
			.filter((k) => k.length > 0);

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

			let score = matchCount * 50;
			if (matchCount === keywords.length) score += 100;
			score -= entry.depth * 2;
			score -= entry.path.length * 0.1;

			results.push({
				path: entry.isDir ? `${entry.path}/` : entry.path,
				score,
			});
		}
	} else {
		const queryLower = trimmed.toLowerCase();

		for (const entry of allPaths) {
			if (type === "file" && entry.isDir) continue;
			if (type === "dir" && !entry.isDir) continue;

			const pathLower = entry.path.toLowerCase();

			if (pathLower.includes(queryLower)) {
				let score = 200;

				const lastSlash = entry.path.lastIndexOf("/");
				const baseName = lastSlash >= 0 ? entry.path.slice(lastSlash + 1).toLowerCase() : pathLower;
				if (baseName.includes(queryLower)) score += 50;
				if (baseName.startsWith(queryLower)) score += 30;

				score -= entry.depth * 2;
				score -= entry.path.length * 0.1;

				results.push({
					path: entry.isDir ? `${entry.path}/` : entry.path,
					score,
				});
				continue;
			}

			const fuzzyScore = fuzzyMatchScore(trimmed, entry.path);
			if (fuzzyScore > 0) {
				results.push({
					path: entry.isDir ? `${entry.path}/` : entry.path,
					score: fuzzyScore,
				});
			}
		}
	}

	results.sort((a, b) => b.score - a.score);
	return results;
}

function regexSearch(allPaths: PathEntry[], pattern: string, type: "file" | "dir" | undefined): SearchResult[] {
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

// ---------------------------------------------------------------------------
// Content Search — ripgrep delegation
// ---------------------------------------------------------------------------

function findRipgrep(): string | null {
	try {
		execFileSync("rg", ["--version"], { stdio: "pipe" });
		return "rg";
	} catch {
		return null;
	}
}

interface ContentSearchOptions {
	glob?: string;
	literal?: boolean;
	ignoreCase?: boolean;
	context?: number;
}

function contentSearch(
	cwd: string,
	query: string,
	path: string | undefined,
	limit: number,
	maxPerFile: number,
	options?: ContentSearchOptions,
): { matches: ContentMatch[]; total: number; truncated: boolean; engine: string } {
	const searchDir = path ? join(cwd, path) : cwd;

	if (!existsSync(searchDir)) {
		return { matches: [], total: 0, truncated: false, engine: "none" };
	}

	const rgBin = findRipgrep();
	const maxResults = limit * 3;

	if (rgBin) {
		return contentSearchRg(rgBin, searchDir, cwd, query, maxResults, limit, maxPerFile, options);
	}

	return contentSearchGrep(searchDir, cwd, query, maxResults, limit, maxPerFile);
}

function contentSearchRg(
	rgBin: string,
	searchDir: string,
	cwd: string,
	query: string,
	maxResults: number,
	limit: number,
	maxPerFile: number,
	options?: ContentSearchOptions,
): { matches: ContentMatch[]; total: number; truncated: boolean; engine: string } {
	try {
		const args = [
			"--no-heading",
			"--with-filename",
			"--line-number",
			"--color=never",
			"--max-count",
			String(maxPerFile),
			"--max-columns",
			"200",
			"--max-columns-preview",
			"-m",
			String(maxResults),
		];

		// New options
		if (options?.literal) {
			args.push("--fixed-strings");
		}
		if (options?.ignoreCase) {
			args.push("--ignore-case");
		}
		if (options?.glob) {
			args.push("--glob", options.glob);
		}
		if (options?.context && options.context > 0) {
			args.push("-C", String(options.context));
		}

		args.push("--", query, searchDir);

		const output = execFileSync(rgBin, args, {
			encoding: "utf-8",
			maxBuffer: 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
		});

		return parseGrepOutput(output, cwd, limit, options?.context);
	} catch (err: unknown) {
		if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 1) {
			return { matches: [], total: 0, truncated: false, engine: "rg" };
		}
		return { matches: [], total: 0, truncated: false, engine: "rg" };
	}
}

function contentSearchGrep(
	searchDir: string,
	cwd: string,
	query: string,
	_maxResults: number,
	limit: number,
	maxPerFile: number,
): { matches: ContentMatch[]; total: number; truncated: boolean; engine: string } {
	try {
		const args = [
			"-rn",
			"--include=*.ts",
			"--include=*.tsx",
			"--include=*.js",
			"--include=*.jsx",
			"--include=*.json",
			"--include=*.md",
			"--include=*.css",
			"--include=*.html",
			"--include=*.py",
			"--include=*.rs",
			"--include=*.go",
			"--include=*.java",
			"--include=*.c",
			"--include=*.cpp",
			"--include=*.h",
			"-m",
			String(maxPerFile),
			"--",
			query,
			searchDir,
		];

		const output = execFileSync("grep", args, {
			encoding: "utf-8",
			maxBuffer: 1024 * 1024,
			stdio: ["pipe", "pipe", "pipe"],
		});

		return parseGrepOutput(output, cwd, limit);
	} catch (err: unknown) {
		if (err && typeof err === "object" && "status" in err && (err as { status: number }).status === 1) {
			return { matches: [], total: 0, truncated: false, engine: "grep" };
		}
		return { matches: [], total: 0, truncated: false, engine: "grep" };
	}
}

function parseGrepOutput(
	output: string,
	cwd: string,
	limit: number,
	contextLines?: number,
): { matches: ContentMatch[]; total: number; truncated: boolean; engine: string } {
	const lines = output.split("\n").filter((l) => l.trim());
	const matches: ContentMatch[] = [];
	const engine = "rg";

	for (const line of lines) {
		// With context lines, ripgrep uses -- as separator and - for context lines
		// Match line format: /path:line:text
		// Context line format: /path-line-text
		const matchLine = line.match(/^(.+?):(\d+):(.*)$/);
		const contextLine = contextLines && contextLines > 0 ? line.match(/^(.+?)-(\d+)-(.*)$/) : null;

		const matched = matchLine || contextLine;
		if (!matched) continue;

		let filePath = matched[1];
		const lineNum = parseInt(matched[2], 10);
		const text = matched[3].trim();

		if (filePath.startsWith(cwd)) {
			filePath = filePath.slice(cwd.length + 1);
		}
		filePath = filePath.split(sep).join("/");

		matches.push({ file: filePath, line: lineNum, text });

		if (matches.length >= limit) break;
	}

	return {
		matches,
		total: lines.length,
		truncated: lines.length > limit,
		engine,
	};
}

function renderContentSearch(
	result: { matches: ContentMatch[]; total: number; truncated: boolean; engine: string },
	query: string,
	path: string | undefined,
	offset: number,
	limit: number,
): string {
	const { matches, total, truncated, engine } = result;
	const lines: string[] = [];

	if (matches.length === 0) {
		const scope = path ? ` in ${path}/` : "";
		lines.push(`No content matches for "${query}"${scope}.`);
		return lines.join("\n");
	}

	// Group by file for compact output
	const grouped = new Map<string, { line: number; text: string }[]>();
	const paginated = matches.slice(offset, offset + limit);

	for (const m of paginated) {
		let entries = grouped.get(m.file);
		if (!entries) {
			entries = [];
			grouped.set(m.file, entries);
		}
		entries.push({ line: m.line, text: m.text });
	}

	for (const [file, entries] of grouped) {
		lines.push(file);
		for (const e of entries) {
			const displayText = e.text.length > 120 ? `${e.text.slice(0, 117)}...` : e.text;
			lines.push(`  ${e.line}: ${displayText}`);
		}
	}

	const from = offset + 1;
	const to = Math.min(offset + limit, matches.length);
	lines.push("");

	const scope = path ? ` in ${path}/` : "";
	if (truncated || offset > 0 || matches.length > limit) {
		const totalLabel = truncated ? `${total}+` : String(total);
		lines.push(
			`Showing ${from}-${to} of ${totalLabel} matches for "${query}"${scope} (${engine}).` +
				(to < matches.length ? ` Use offset=${to} to see more.` : ""),
		);
	} else {
		lines.push(`${matches.length} matches for "${query}"${scope} (${engine}).`);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Browse Rendering
// ---------------------------------------------------------------------------

function renderBrowse(
	browseCache: LRUBrowseCache,
	flatIndex: PathEntry[],
	path: string | undefined,
	depth: number,
	type: "file" | "dir" | undefined,
	offset: number,
	limit: number,
): string {
	const entries: string[] = [];

	const collectFromPath = (dirPath: string, currentDepth: number, indent: string) => {
		if (currentDepth > depth) return;

		const cacheKey = dirPath;
		let cached = browseCache.get(cacheKey);
		if (!cached) {
			const children = buildBrowseChildren(flatIndex, dirPath);
			cached = { children, time: Date.now() };
			browseCache.set(cacheKey, cached);
		}

		for (const child of cached.children) {
			if (child.isDir) {
				const showDir = type !== "file";
				if (showDir) {
					let line = `${indent}${child.name}/`;
					const meta: string[] = [];
					if (child.fileCount !== undefined && child.fileCount > 0) {
						meta.push(`${child.fileCount} files`);
					}
					if (child.dirCount !== undefined && child.dirCount > 0) {
						meta.push(`${child.dirCount} dirs`);
					}
					if (meta.length > 0) {
						line += `  (${meta.join(", ")})`;
					}
					entries.push(line);
				}

				if (currentDepth < depth) {
					const childPath = dirPath ? `${dirPath}/${child.name}` : child.name;
					collectFromPath(childPath, currentDepth + 1, showDir ? `${indent}  ` : indent);
				}
			} else {
				if (type !== "dir") {
					entries.push(`${indent}${child.name}`);
				}
			}
		}
	};

	collectFromPath(path ?? "", 1, path ? "  " : "");

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
// Search Rendering
// ---------------------------------------------------------------------------

function renderSearch(results: SearchResult[], query: string, isRegex: boolean, offset: number, limit: number): string {
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
// Stateful index manager (per cwd)
// ---------------------------------------------------------------------------

interface SearchState {
	cwd: string;
	flatIndex: PathEntry[] | null;
	dirty: boolean;
	cacheTime: number;
	indexReady: boolean;
	indexingPromise: Promise<void> | null;
	browseCache: LRUBrowseCache;
	watcher: FSWatcher | null;
	debounceTimer: ReturnType<typeof setTimeout> | null;
}

function createState(cwd: string): SearchState {
	return {
		cwd,
		flatIndex: null,
		dirty: true,
		cacheTime: 0,
		indexReady: false,
		indexingPromise: null,
		browseCache: new LRUBrowseCache(BROWSE_CACHE_MAX),
		watcher: null,
		debounceTimer: null,
	};
}

function invalidateCache(state: SearchState): void {
	if (state.debounceTimer) clearTimeout(state.debounceTimer);
	state.debounceTimer = setTimeout(() => {
		state.dirty = true;
		state.browseCache.clear();
	}, DEBOUNCE_MS);
}

function buildIndex(state: SearchState): PathEntry[] {
	const result = scanProjectFlat(state.cwd);
	state.flatIndex = result;
	state.cacheTime = Date.now();
	state.dirty = false;
	state.indexReady = true;
	return result;
}

async function ensureIndex(state: SearchState): Promise<PathEntry[]> {
	if (state.flatIndex && !state.dirty && Date.now() - state.cacheTime <= CACHE_TTL) {
		return state.flatIndex;
	}
	if (state.indexingPromise) {
		await state.indexingPromise;
		if (state.flatIndex) return state.flatIndex;
	}
	return buildIndex(state);
}

function startWatcher(state: SearchState): void {
	try {
		state.watcher = watch(state.cwd, { recursive: true }, () => {
			invalidateCache(state);
		});
		state.watcher.on("error", () => {
			state.watcher = null;
		});
	} catch {
		// fs.watch not supported, rely on TTL
	}
}

function dirExistsInIndex(index: PathEntry[], dirPath: string): boolean {
	if (!dirPath) return true;
	return index.some((e) => e.isDir && e.path === dirPath);
}

function fileExistsInIndex(index: PathEntry[], filePath: string): boolean {
	return index.some((e) => !e.isDir && e.path === filePath);
}

// ---------------------------------------------------------------------------
// Tool
// ---------------------------------------------------------------------------

/** Shared state keyed by cwd — allows multiple createSearchTool() calls to share cache */
const stateMap = new Map<string, SearchState>();

/** Clean up watchers and timers for all cached search states. */
export function cleanupAllSearchStates(): void {
	for (const state of stateMap.values()) {
		if (state.watcher) {
			state.watcher.close();
			state.watcher = null;
		}
		if (state.debounceTimer) {
			clearTimeout(state.debounceTimer);
			state.debounceTimer = null;
		}
	}
	stateMap.clear();
}

function getOrCreateState(cwd: string): SearchState {
	let state = stateMap.get(cwd);
	if (!state) {
		state = createState(cwd);
		startWatcher(state);
		// Kick off background indexing
		state.indexingPromise = new Promise<void>((resolve) => {
			setImmediate(() => {
				buildIndex(state!);
				state!.indexingPromise = null;
				resolve();
			});
		});
		stateMap.set(cwd, state);
	}
	return state;
}

export function createSearchTool(cwd: string, _options?: SearchToolOptions): AgentTool<typeof searchSchema> {
	return {
		name: "search",
		label: "search",
		sideEffects: false,
		description:
			"Browse and search project files with minimal token usage. Navigate layer by layer with depth, or search with fuzzy/regex query. Respects .gitignore.\n\n" +
			"Browse mode (no query): Use path + depth to explore directories incrementally.\n" +
			"Search mode (with query): Fuzzy match by default. Wrap in /pattern/ for regex.\n" +
			"Content mode (with content): Search file contents via ripgrep. Supports regex patterns (e.g., alternation with |, wildcards with .*). Supports glob filtering, literal search, case-insensitive, and context lines.\n\n" +
			"Examples:\n" +
			"  search()                              → top-level overview\n" +
			'  search(path="src", depth=1)           → src/ contents\n' +
			'  search(path="src", type="dir")        → only subdirectories\n' +
			'  search(query="input system")          → fuzzy search\n' +
			'  search(query="/auth.*middleware/")     → regex search\n' +
			'  search(query="config", offset=50)     → paginate results\n' +
			'  search(content="handleAuth")           → content search\n' +
			'  search(content="TODO|FIXME|HACK")      → content search with regex alternation\n' +
			'  search(content="TODO", path="src")     → scoped content search\n' +
			'  search(content="useState", glob="*.tsx") → content search filtered by file type\n' +
			'  search(content="$variable", literal=true) → literal string search (no regex)\n' +
			'  search(content="handleAuth", context=2)  → show 2 lines before/after each match',
		parameters: searchSchema,
		execute: async (
			_toolCallId: string,
			params: Static<typeof searchSchema>,
			signal?: AbortSignal,
		): Promise<{ content: { type: "text"; text: string }[]; details: SearchToolDetails }> => {
			if (signal?.aborted) {
				throw new Error("Operation aborted");
			}

			const state = getOrCreateState(cwd);

			// --- Input normalization ---
			const normalizePath = (p: string | undefined): string | undefined => {
				if (!p) return undefined;
				const normalized = p.replace(/^@/, "").replace(/^\.\//, "").replace(/\/+$/, "");
				if (normalized === "." || normalized === "") return undefined;
				return normalized;
			};

			const offset = Math.max(0, params.offset ?? 0);
			const type = params.type as "file" | "dir" | undefined;
			const path = normalizePath(params.path);

			// --- Content search mode ---
			if (params.content) {
				const limit = Math.max(1, Math.min(params.limit ?? CONTENT_DEFAULT_LIMIT, CONTENT_MAX_LIMIT));
				const contentQuery = params.content.trim();

				if (!contentQuery) {
					return {
						content: [{ type: "text", text: "Empty content query." }],
						details: { mode: "content", error: "empty_query" },
					};
				}

				const result = contentSearch(cwd, contentQuery, path, limit, CONTENT_MAX_PER_FILE, {
					glob: params.glob,
					literal: params.literal,
					ignoreCase: params.ignoreCase,
					context: params.context,
				});
				const output = renderContentSearch(result, contentQuery, path, offset, limit);

				return {
					content: [{ type: "text", text: output }],
					details: {
						mode: "content",
						query: contentQuery,
						path,
						total: result.total,
						offset,
						limit,
						engine: result.engine,
					},
				};
			}

			// --- Path search mode ---
			if (params.query) {
				const limit = Math.max(1, Math.min(params.limit ?? SEARCH_DEFAULT_LIMIT, SEARCH_MAX_LIMIT));
				const query = params.query.trim();

				const index = await ensureIndex(state);

				// Scope to subtree if path specified
				let searchIndex = index;
				if (path) {
					if (fileExistsInIndex(index, path)) {
						return {
							content: [{ type: "text", text: `Not a directory: ${path}. Use read tool for file contents.` }],
							details: { mode: "search", error: "not_a_directory" },
						};
					}
					if (!dirExistsInIndex(index, path)) {
						return {
							content: [{ type: "text", text: `Path not found: ${path}` }],
							details: { mode: "search", error: "not_found" },
						};
					}
					const prefix = `${path}/`;
					searchIndex = index.filter((e) => e.path.startsWith(prefix));
				}

				const isRegex = query.startsWith("/") && query.endsWith("/") && query.length > 2;

				let results: SearchResult[];
				if (isRegex) {
					const pattern = query.slice(1, -1);
					results = regexSearch(searchIndex, pattern, type);
				} else {
					results = fuzzySearch(searchIndex, query, type);
				}

				const output = renderSearch(results, isRegex ? query.slice(1, -1) : query, isRegex, offset, limit);

				return {
					content: [{ type: "text", text: output }],
					details: { mode: "search", query, path, total: results.length, offset, limit },
				};
			}

			// --- Browse mode ---
			const limit = Math.max(1, Math.min(params.limit ?? BROWSE_DEFAULT_LIMIT, BROWSE_MAX_LIMIT));
			const depth = params.depth ?? 1;

			const index = await ensureIndex(state);

			if (path) {
				if (fileExistsInIndex(index, path)) {
					return {
						content: [{ type: "text", text: `Not a directory: ${path}. Use read tool for file contents.` }],
						details: { mode: "browse", error: "not_a_directory" },
					};
				}
				if (!dirExistsInIndex(index, path)) {
					return {
						content: [{ type: "text", text: `Path not found: ${path}` }],
						details: { mode: "browse", error: "not_found" },
					};
				}
			}

			const output = renderBrowse(state.browseCache, index, path, depth, type, offset, limit);

			return {
				content: [{ type: "text", text: output }],
				details: { mode: "browse", path: path ?? ".", depth, offset, limit },
			};
		},
	};
}

/** Default search tool using process.cwd() - for backwards compatibility */
export const searchTool = createSearchTool(process.cwd());
