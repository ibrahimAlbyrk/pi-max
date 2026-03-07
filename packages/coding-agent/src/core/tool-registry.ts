/**
 * Tool registry - canonical runtime tool metadata and registration for the coding agent.
 *
 * Provides a single source of truth for all tool metadata during a session.
 * Stores built-in AgentTool instances alongside extension/SDK RegisteredTool
 * definitions, detects duplicate registrations, and resolves entries into
 * executable AgentTool instances with the correct wrappers applied.
 */

import type { AgentTool } from "@mariozechner/pi-agent-core";
import type { ExtensionRunner } from "./extensions/runner.js";
import type { RegisteredTool, ToolDefinition, ToolInfo } from "./extensions/types.js";
import {
	applyToolMiddleware,
	type ToolMiddlewareFn,
	wrapRegisteredTool,
	wrapToolWithExtensions,
} from "./extensions/wrapper.js";

// ============================================================================
// Types
// ============================================================================

/** Origin of a registered tool entry. */
export type ToolOrigin = "builtin" | "extension" | "sdk";

/** Registry entry for a built-in AgentTool. */
export interface BuiltinToolEntry {
	readonly origin: "builtin";
	readonly tool: AgentTool;
}

/** Registry entry for an extension or SDK-provided tool definition. */
export interface ExtensionOrSdkToolEntry {
	readonly origin: "extension" | "sdk";
	readonly registeredTool: RegisteredTool;
}

/** Union of all registry entry types. */
export type ToolRegistryEntry = BuiltinToolEntry | ExtensionOrSdkToolEntry;

/** Information about a detected duplicate registration. */
export interface ToolRegistryDuplicate {
	readonly name: string;
	readonly previousOrigin: ToolOrigin;
	readonly incomingOrigin: ToolOrigin;
}

// ============================================================================
// Validation Types
// ============================================================================

/** Severity level for a tool validation issue. */
export type ToolValidationSeverity = "warning" | "info";

/**
 * Machine-readable code identifying the kind of validation issue.
 *
 * - name_empty: tool name is empty
 * - name_format: name contains characters outside [a-zA-Z0-9_-]
 * - name_length: name exceeds the provider-enforced max length
 * - description_empty: tool description is missing or blank
 * - label_empty: tool label is missing or blank (UI concern, info-only)
 * - schema_type_missing: parameters schema lacks a "type" field
 * - schema_not_object: parameters schema "type" is not "object"
 * - duplicate_override: this registration replaced an earlier one
 */
export type ToolValidationCode =
	| "name_empty"
	| "name_format"
	| "name_length"
	| "description_empty"
	| "label_empty"
	| "schema_type_missing"
	| "schema_not_object"
	| "duplicate_override";

/** A single validation issue found when a tool was registered. */
export interface ToolValidationIssue {
	readonly code: ToolValidationCode;
	readonly severity: ToolValidationSeverity;
	readonly message: string;
}

/** Aggregated validation diagnostics for one registered tool. */
export interface ToolRegistryDiagnostic {
	readonly name: string;
	readonly origin: ToolOrigin;
	readonly issues: ReadonlyArray<ToolValidationIssue>;
}

// ============================================================================
// Internal Validation Helpers
// ============================================================================

/** Tool names must match this pattern to be accepted by Anthropic and OpenAI. */
const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Maximum tool name length enforced by Anthropic and OpenAI. */
const TOOL_NAME_MAX_LENGTH = 64;

function _validateName(name: string): ToolValidationIssue[] {
	const issues: ToolValidationIssue[] = [];
	if (name.length === 0) {
		issues.push({
			code: "name_empty",
			severity: "warning",
			message: "Tool name is empty. LLM providers require a non-empty name.",
		});
		return issues;
	}
	if (!TOOL_NAME_PATTERN.test(name)) {
		issues.push({
			code: "name_format",
			severity: "warning",
			message: `Tool "${name}" name contains characters outside [a-zA-Z0-9_-]. Some LLM providers (Anthropic, OpenAI) may reject it.`,
		});
	}
	if (name.length > TOOL_NAME_MAX_LENGTH) {
		issues.push({
			code: "name_length",
			severity: "warning",
			message: `Tool "${name}" name is ${name.length} characters, exceeding the ${TOOL_NAME_MAX_LENGTH}-character limit enforced by some LLM providers.`,
		});
	}
	return issues;
}

function _validateDescription(name: string, description: string): ToolValidationIssue[] {
	if (!description || description.trim().length === 0) {
		return [
			{
				code: "description_empty",
				severity: "warning",
				message: `Tool "${name}" has an empty description. The LLM relies on the description to know when and how to use the tool.`,
			},
		];
	}
	return [];
}

function _validateLabel(name: string, label: string | undefined): ToolValidationIssue[] {
	if (!label || label.trim().length === 0) {
		return [
			{
				code: "label_empty",
				severity: "info",
				message: `Tool "${name}" has no label. A human-readable label aids UI display.`,
			},
		];
	}
	return [];
}

function _validateSchema(name: string, parameters: Record<string, unknown>): ToolValidationIssue[] {
	const issues: ToolValidationIssue[] = [];
	if (!("type" in parameters)) {
		issues.push({
			code: "schema_type_missing",
			severity: "warning",
			message: `Tool "${name}" parameter schema is missing a "type" field. LLM providers expect an object-typed schema.`,
		});
	} else if (parameters.type !== "object") {
		issues.push({
			code: "schema_not_object",
			severity: "info",
			message: `Tool "${name}" parameter schema has type "${String(parameters.type)}" instead of "object". Most LLM providers require object-typed tool parameters.`,
		});
	}
	return issues;
}

// ============================================================================
// ToolRegistry
// ============================================================================

/**
 * Canonical runtime tool registry for the coding agent.
 *
 * Single source of truth for tool metadata during a session. Stores built-in
 * AgentTool instances and extension/SDK RegisteredTool definitions. Registration
 * uses last-write-wins semantics; duplicates are recorded and available via
 * getDuplicates() for diagnostic purposes.
 *
 * Resolves entries into executable AgentTool instances for use in the agent loop,
 * applying the appropriate wrappers for context injection and extension interception.
 *
 * Registration priority (last-write-wins): SDK > extension > builtin.
 * In practice, call registerBuiltin() first, then registerExtension(), then
 * registerSdk() to achieve this priority automatically.
 */
export class ToolRegistry {
	private readonly _entries: Map<string, ToolRegistryEntry> = new Map();
	private readonly _duplicates: ToolRegistryDuplicate[] = [];
	private readonly _middlewares: Map<string, ToolMiddlewareFn[]> = new Map();
	/**
	 * Validation issues collected during registration.
	 * Keyed by tool name; value is the issues for the most recent registration of that name.
	 */
	private readonly _validationIssues: Map<string, ToolValidationIssue[]> = new Map();

	// =========================================================================
	// Internal Validation
	// =========================================================================

	/**
	 * Validate a tool's metadata and schema, storing the results by name.
	 * Replaces any previously stored issues for the same name (last-write-wins
	 * semantics mirror the entry map).
	 */
	private _validateAndRecord(
		name: string,
		description: string,
		label: string | undefined,
		parameters: Record<string, unknown>,
	): void {
		const issues: ToolValidationIssue[] = [
			..._validateName(name),
			..._validateDescription(name, description),
			..._validateLabel(name, label),
			..._validateSchema(name, parameters),
		];
		this._validationIssues.set(name, issues);
	}

	/**
	 * Register a built-in AgentTool.
	 * If a tool with the same name is already registered, the existing entry is
	 * replaced and the duplicate is recorded in getDuplicates().
	 */
	registerBuiltin(tool: AgentTool): void {
		const existing = this._entries.get(tool.name);
		if (existing) {
			this._duplicates.push({
				name: tool.name,
				previousOrigin: existing.origin,
				incomingOrigin: "builtin",
			});
		}
		this._entries.set(tool.name, { origin: "builtin", tool });
		this._validateAndRecord(tool.name, tool.description, tool.label, tool.parameters as Record<string, unknown>);
	}

	/**
	 * Register an extension-provided RegisteredTool.
	 * If a tool with the same name is already registered, the existing entry is
	 * replaced and the duplicate is recorded in getDuplicates().
	 */
	registerExtension(registeredTool: RegisteredTool): void {
		const { name } = registeredTool.definition;
		const existing = this._entries.get(name);
		if (existing) {
			this._duplicates.push({
				name,
				previousOrigin: existing.origin,
				incomingOrigin: "extension",
			});
		}
		this._entries.set(name, { origin: "extension", registeredTool });
		const { definition } = registeredTool;
		this._validateAndRecord(
			name,
			definition.description,
			definition.label,
			definition.parameters as Record<string, unknown>,
		);
	}

	/**
	 * Register an SDK-provided ToolDefinition (from config.customTools).
	 * If a tool with the same name is already registered, the existing entry is
	 * replaced and the duplicate is recorded in getDuplicates().
	 *
	 * SDK tools are designed to override built-in tools that share the same name
	 * (e.g., the bg and task ToolDefinitions override the corresponding AgentTool
	 * built-ins with richer context-aware implementations).
	 */
	registerSdk(definition: ToolDefinition): void {
		const { name } = definition;
		const existing = this._entries.get(name);
		if (existing) {
			this._duplicates.push({
				name,
				previousOrigin: existing.origin,
				incomingOrigin: "sdk",
			});
		}
		this._entries.set(name, {
			origin: "sdk",
			registeredTool: { definition, extensionPath: "<sdk>" },
		});
		this._validateAndRecord(
			name,
			definition.description,
			definition.label,
			definition.parameters as Record<string, unknown>,
		);
	}

	// =========================================================================
	// Middleware Registration
	// =========================================================================

	/**
	 * Register an execution middleware function for a named tool.
	 *
	 * Middleware is appended in call order — the first middleware registered is
	 * the outermost (called first). Middleware runs inside the extension
	 * tool_call/tool_result interception layer, so extension event handlers still
	 * fire around the full middleware chain.
	 *
	 * Registering middleware for an unknown tool name is allowed; if the tool is
	 * never registered, the middleware is silently unused.
	 */
	registerMiddleware(toolName: string, middleware: ToolMiddlewareFn): void {
		const existing = this._middlewares.get(toolName);
		if (existing) {
			existing.push(middleware);
		} else {
			this._middlewares.set(toolName, [middleware]);
		}
	}

	/**
	 * Return the ordered middleware list for a tool name.
	 * Returns an empty array if no middleware has been registered for that tool.
	 */
	getMiddleware(toolName: string): ReadonlyArray<ToolMiddlewareFn> {
		return this._middlewares.get(toolName) ?? [];
	}

	// =========================================================================
	// Querying
	// =========================================================================

	/** Whether a tool with the given name is registered. */
	has(name: string): boolean {
		return this._entries.has(name);
	}

	/** Whether the named tool's current entry has "builtin" origin. */
	isBuiltin(name: string): boolean {
		return this._entries.get(name)?.origin === "builtin";
	}

	/** Get the registry entry for a tool name, or undefined if not found. */
	getEntry(name: string): ToolRegistryEntry | undefined {
		return this._entries.get(name);
	}

	/** All registered entries in insertion order (position fixed at first registration). */
	getAll(): ToolRegistryEntry[] {
		return Array.from(this._entries.values());
	}

	/** All registered tool names in insertion order. */
	getNames(): string[] {
		return Array.from(this._entries.keys());
	}

	/**
	 * Duplicate registrations recorded during the lifetime of this registry instance.
	 * Returned in detection order.
	 */
	getDuplicates(): ReadonlyArray<ToolRegistryDuplicate> {
		return this._duplicates;
	}

	/**
	 * Aggregated validation diagnostics for all registered tools.
	 *
	 * Each entry contains the tool name, its current origin, and the list of
	 * issues found during registration (name format/length, description, label,
	 * schema sanity). Duplicate-override issues are prepended to the issue list
	 * of the tool that performed the override.
	 *
	 * Only entries that have at least one issue are included. Returns an empty
	 * array when all registered tools pass validation cleanly.
	 */
	getDiagnostics(): ReadonlyArray<ToolRegistryDiagnostic> {
		const results: ToolRegistryDiagnostic[] = [];

		// Build a lookup of duplicate issues per tool name (only the overriding entry
		// gets the duplicate_override issue, so we record all duplicates for each name).
		const duplicateIssuesByName = new Map<string, ToolValidationIssue[]>();
		for (const dup of this._duplicates) {
			let list = duplicateIssuesByName.get(dup.name);
			if (!list) {
				list = [];
				duplicateIssuesByName.set(dup.name, list);
			}
			list.push({
				code: "duplicate_override",
				severity: "info",
				message: `Tool "${dup.name}" (${dup.incomingOrigin}) overrode an existing ${dup.previousOrigin} registration.`,
			});
		}

		for (const [name, entry] of this._entries) {
			const validationIssues = this._validationIssues.get(name) ?? [];
			const duplicateIssues = duplicateIssuesByName.get(name) ?? [];
			const issues: ToolValidationIssue[] = [...duplicateIssues, ...validationIssues];
			if (issues.length > 0) {
				results.push({ name, origin: entry.origin, issues });
			}
		}

		return results;
	}

	/**
	 * Re-evaluate all registered entries and return validation diagnostics.
	 *
	 * Equivalent to getDiagnostics() but signals intent to perform a full
	 * validation pass (e.g., called explicitly after all registrations are done).
	 * Runtime behavior is unchanged; this is informational only.
	 */
	validateAll(): ReadonlyArray<ToolRegistryDiagnostic> {
		return this.getDiagnostics();
	}

	/**
	 * ToolInfo metadata for all registered tools.
	 * Suitable for implementing AgentSession.getAllTools().
	 */
	getToolInfos(): ToolInfo[] {
		return Array.from(this._entries.values()).map((entry): ToolInfo => {
			if (entry.origin === "builtin") {
				return {
					name: entry.tool.name,
					description: entry.tool.description,
					parameters: entry.tool.parameters,
				};
			}
			const { definition } = entry.registeredTool;
			return {
				name: definition.name,
				description: definition.description,
				parameters: definition.parameters,
			};
		});
	}

	// =========================================================================
	// Resolution
	// =========================================================================

	/**
	 * Resolve active tools into fully wrapped AgentTool instances.
	 *
	 * Built-in tools are wrapped with the extension interception layer if a runner
	 * is provided. Extension/SDK tools are first wrapped via wrapRegisteredTool()
	 * for context injection, then wrapped with the interception layer.
	 *
	 * Any middleware registered via registerMiddleware() is applied to each tool
	 * after context injection but before the extension interception wrapper,
	 * preserving extension event ordering.
	 *
	 * If no runner is provided, extension/SDK tools are excluded and built-in
	 * tools are returned with only middleware applied (no interception wrapper).
	 *
	 * Returns a fully resolved list ready to be set on the agent directly.
	 */
	resolveActive(activeNames: ReadonlySet<string>, runner: ExtensionRunner | undefined): AgentTool[] {
		const tools: AgentTool[] = [];
		for (const [name, entry] of this._entries) {
			if (!activeNames.has(name)) continue;
			const middleware = this._middlewares.get(name) ?? [];
			if (entry.origin === "builtin") {
				const base = applyToolMiddleware(entry.tool, middleware);
				tools.push(runner ? wrapToolWithExtensions(base, runner) : base);
			} else {
				if (!runner) continue;
				const inner = applyToolMiddleware(wrapRegisteredTool(entry.registeredTool, runner), middleware);
				tools.push(wrapToolWithExtensions(inner, runner));
			}
		}
		return tools;
	}

	/**
	 * Resolve all registered tools into fully wrapped AgentTool instances.
	 *
	 * Built-in tools are wrapped with the extension interception layer if a runner
	 * is provided. Extension/SDK tools are first wrapped via wrapRegisteredTool()
	 * for context injection, then wrapped with the interception layer.
	 *
	 * Any middleware registered via registerMiddleware() is applied to each tool
	 * after context injection but before the extension interception wrapper,
	 * preserving extension event ordering.
	 *
	 * If no runner is provided, extension/SDK tools are excluded and built-in
	 * tools are returned with only middleware applied (no interception wrapper).
	 *
	 * Returns a Map<name, AgentTool> suitable for setActiveToolsByName() lookups
	 * and getAllTools() queries.
	 */
	resolveAll(runner: ExtensionRunner | undefined): Map<string, AgentTool> {
		const resolved = new Map<string, AgentTool>();
		for (const [name, entry] of this._entries) {
			const middleware = this._middlewares.get(name) ?? [];
			if (entry.origin === "builtin") {
				const base = applyToolMiddleware(entry.tool, middleware);
				resolved.set(name, runner ? wrapToolWithExtensions(base, runner) : base);
			} else {
				if (!runner) continue;
				const inner = applyToolMiddleware(wrapRegisteredTool(entry.registeredTool, runner), middleware);
				resolved.set(name, wrapToolWithExtensions(inner, runner));
			}
		}
		return resolved;
	}
}
