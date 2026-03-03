import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { CircularReferenceError, ExtendsDepthError, PromptNotFoundError, VariableRequiredError } from "./errors.js";
import { parsePromptFile } from "./parser.js";
import { renderTemplate } from "./renderer.js";
import type {
	ParsedPrompt,
	PromptMeta,
	PromptRegistry,
	PromptRegistryOptions,
	RendererContext,
	RenderVariables,
	ResolvedPrompt,
	ValidationResult,
	VariableDefinition,
} from "./types.js";

const DEFAULT_EXTENSION = ".prompt.md";
const DEFAULT_MAX_EXTENDS_DEPTH = 5;

/**
 * Create a new PromptRegistry that scans the given templates directory.
 */
export function createPromptRegistry(options: PromptRegistryOptions): PromptRegistry {
	const extension = options.extension ?? DEFAULT_EXTENSION;
	const maxExtendsDepth = options.maxExtendsDepth ?? DEFAULT_MAX_EXTENDS_DEPTH;
	const templatesDir = resolve(options.templatesDir);
	const additionalDirs = (options.additionalDirs ?? []).map((d) => resolve(d));

	// Caches
	const parsedCache = new Map<string, ParsedPrompt>();
	const resolvedCache = new Map<string, ResolvedPrompt>();

	// ------------------------------------------------------------------
	// Scanning
	// ------------------------------------------------------------------

	function scanDirectory(dir: string, rootDir: string): void {
		let entries: string[];
		try {
			entries = readdirSync(dir);
		} catch {
			return;
		}

		for (const entry of entries) {
			const fullPath = join(dir, entry);
			let stat: ReturnType<typeof statSync>;
			try {
				stat = statSync(fullPath);
			} catch {
				continue;
			}

			if (stat.isDirectory()) {
				scanDirectory(fullPath, rootDir);
			} else if (entry.endsWith(extension)) {
				const parsed = parsePromptFile(fullPath, rootDir, extension);
				const name = parsed.meta.name;
				parsedCache.set(name, parsed);
			}
		}
	}

	function loadAll(): void {
		parsedCache.clear();
		resolvedCache.clear();
		scanDirectory(templatesDir, templatesDir);
		for (const dir of additionalDirs) {
			scanDirectory(dir, dir);
		}
	}

	// Initial load
	loadAll();

	// ------------------------------------------------------------------
	// Resolution (extends + includes)
	// ------------------------------------------------------------------

	function getParsed(name: string): ParsedPrompt {
		const cached = parsedCache.get(name);
		if (!cached) {
			throw new PromptNotFoundError(name);
		}
		return cached;
	}

	function resolvePrompt(name: string): ResolvedPrompt {
		const cached = resolvedCache.get(name);
		if (cached) return cached;

		const parsed = getParsed(name);
		const resolved = resolveWithInheritance(parsed, []);
		resolvedCache.set(name, resolved);
		return resolved;
	}

	function resolveWithInheritance(parsed: ParsedPrompt, chain: string[]): ResolvedPrompt {
		const name = parsed.meta.name;

		// Circular reference detection
		if (chain.includes(name)) {
			throw new CircularReferenceError([...chain, name]);
		}

		// Depth check
		if (chain.length >= maxExtendsDepth) {
			throw new ExtendsDepthError(name, maxExtendsDepth);
		}

		let resolvedBody = parsed.rawBody;
		let mergedVariables = [...parsed.meta.variables];

		// Resolve extends (parent body prepended)
		if (parsed.meta.extends) {
			const parentParsed = getParsed(parsed.meta.extends);
			const parentResolved = resolveWithInheritance(parentParsed, [...chain, name]);

			// Prepend parent body
			resolvedBody = `${parentResolved.resolvedBody}\n${resolvedBody}`;

			// Merge variables: parent variables first, child can override defaults
			mergedVariables = mergeVariables(parentResolved.meta.variables, parsed.meta.variables);
		}

		// Resolve includes
		if (parsed.meta.includes && parsed.meta.includes.length > 0) {
			resolvedBody = resolveIncludes(resolvedBody, parsed.meta.includes, [...chain, name]);
		}

		const resolved: ResolvedPrompt = {
			meta: {
				...parsed.meta,
				variables: mergedVariables,
			},
			rawBody: parsed.rawBody,
			resolvedBody,
		};

		return resolved;
	}

	/**
	 * Merge parent and child variable definitions.
	 * Child definitions override parent definitions with the same name.
	 */
	function mergeVariables(parent: VariableDefinition[], child: VariableDefinition[]): VariableDefinition[] {
		const merged = new Map<string, VariableDefinition>();
		for (const v of parent) {
			merged.set(v.name, v);
		}
		for (const v of child) {
			merged.set(v.name, v);
		}
		return [...merged.values()];
	}

	/**
	 * Resolve includes in the body.
	 * Two modes:
	 * 1. Manual placement: {{> partial-name}} in body -> replace with partial content
	 * 2. Auto-append: if no manual placements found, append includes at end
	 */
	function resolveIncludes(body: string, includes: string[], chain: string[]): string {
		const partialPattern = /\{\{>\s*([^}]+)\s*\}\}/g;
		const hasManualPlacements = partialPattern.test(body);

		if (hasManualPlacements) {
			// Manual mode: replace {{> name}} with resolved content
			// The actual replacement happens at render time via resolvePartial in context.
			// But we need to also ensure includes without manual placement are not lost.
			// Keep the {{> name}} tags for the renderer to handle.
			return body;
		}

		// Auto-append mode: append each include's resolved body at end
		let result = body;
		for (const includeName of includes) {
			const includeParsed = getParsed(includeName);
			const includeResolved = resolveWithInheritance(includeParsed, chain);
			result = `${result}\n${includeResolved.resolvedBody}`;
		}

		return result;
	}

	// ------------------------------------------------------------------
	// Rendering
	// ------------------------------------------------------------------

	function render(name: string, variables?: RenderVariables): string {
		const resolved = resolvePrompt(name);
		const vars = applyDefaults(resolved.meta.variables, variables ?? {});

		// Check required variables
		validateRequiredVariables(resolved.meta, vars);

		const ctx: RendererContext = {
			variables: vars,
			resolvePartial: (partialName: string) => {
				// Render the partial with the same variables context
				const partialResolved = resolvePrompt(partialName);
				return renderTemplate(
					partialResolved.resolvedBody,
					{ variables: vars, resolvePartial: ctx.resolvePartial },
					partialName,
				);
			},
		};

		return renderTemplate(resolved.resolvedBody, ctx, name);
	}

	function applyDefaults(definitions: VariableDefinition[], provided: RenderVariables): RenderVariables {
		const result = { ...provided };
		for (const def of definitions) {
			if (result[def.name] === undefined && def.default !== undefined) {
				result[def.name] = def.default;
			}
		}
		return result;
	}

	function validateRequiredVariables(meta: PromptMeta, variables: RenderVariables): void {
		for (const def of meta.variables) {
			if (def.required && variables[def.name] === undefined) {
				throw new VariableRequiredError(def.name, meta.name);
			}
		}
	}

	// ------------------------------------------------------------------
	// Query API
	// ------------------------------------------------------------------

	function getMeta(name: string): PromptMeta {
		return resolvePrompt(name).meta;
	}

	function list(): string[] {
		return [...parsedCache.keys()].sort();
	}

	function listByCategory(category: string): string[] {
		return [...parsedCache.values()]
			.filter((p) => p.meta.category === category)
			.map((p) => p.meta.name)
			.sort();
	}

	// ------------------------------------------------------------------
	// Cache management
	// ------------------------------------------------------------------

	function invalidate(name?: string): void {
		if (name) {
			// Re-parse from disk if file still exists
			const existing = parsedCache.get(name);
			if (existing) {
				try {
					const reparsed = parsePromptFile(existing.meta.filePath, templatesDir, extension);
					parsedCache.set(name, reparsed);
				} catch {
					parsedCache.delete(name);
				}
			}
			resolvedCache.delete(name);
			// Also invalidate anything that extends/includes this prompt
			for (const [key, resolved] of resolvedCache) {
				if (resolved.meta.extends === name || resolved.meta.includes?.includes(name)) {
					resolvedCache.delete(key);
				}
			}
		} else {
			// Full reload
			loadAll();
		}
	}

	// ------------------------------------------------------------------
	// Validation
	// ------------------------------------------------------------------

	function validate(): ValidationResult[] {
		const results: ValidationResult[] = [];

		for (const [name, parsed] of parsedCache) {
			const errors: string[] = [];
			const warnings: string[] = [];

			// Check extends reference
			if (parsed.meta.extends) {
				if (!parsedCache.has(parsed.meta.extends)) {
					errors.push(`extends "${parsed.meta.extends}" not found`);
				} else {
					// Check for circular extends
					try {
						resolvePrompt(name);
					} catch (err) {
						if (err instanceof CircularReferenceError) {
							errors.push(`circular extends: ${err.chain.join(" -> ")}`);
						} else if (err instanceof ExtendsDepthError) {
							errors.push(`extends depth exceeded max ${maxExtendsDepth}`);
						}
					}
				}
			}

			// Check includes references
			if (parsed.meta.includes) {
				for (const inc of parsed.meta.includes) {
					if (!parsedCache.has(inc)) {
						errors.push(`include "${inc}" not found`);
					}
				}
			}

			// Check for {{> partial}} references in body
			const partialPattern = /\{\{>\s*([^}]+)\s*\}\}/g;
			for (const partialMatch of parsed.rawBody.matchAll(partialPattern)) {
				const partialName = partialMatch[1].trim();
				if (!parsedCache.has(partialName)) {
					errors.push(`partial "{{> ${partialName}}}" not found`);
				}
			}

			// Check for variables with no default and warn
			for (const v of parsed.meta.variables) {
				if (!v.required && v.default === undefined) {
					warnings.push(`optional variable "${v.name}" has no default value`);
				}
			}

			// Check for undeclared variables in body
			const varPattern = /\{\{([^#/>{].*?)\}\}/g;
			for (const varMatch of parsed.rawBody.matchAll(varPattern)) {
				const varName = varMatch[1].trim().split(".")[0];
				// Skip if it's a well-known keyword or if variables are not declared
				if (parsed.meta.variables.length > 0) {
					const isDeclared = parsed.meta.variables.some((v) => v.name === varName);
					if (!isDeclared) {
						warnings.push(`variable "{{${varName}}}" used in body but not declared in frontmatter`);
					}
				}
			}

			results.push({ promptName: name, errors, warnings });
		}

		return results;
	}

	// ------------------------------------------------------------------
	// Public interface
	// ------------------------------------------------------------------

	return {
		render,
		getMeta,
		list,
		listByCategory,
		invalidate,
		validate,
	};
}
