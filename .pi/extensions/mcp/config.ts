/**
 * MCP Gateway Extension — Configuration Loading
 *
 * Loads mcp.json from two locations, merges them (project-local overrides
 * global), performs environment-variable interpolation, validates each server
 * definition, and returns a ready-to-use McpConfig together with any warnings
 * accumulated along the way.
 *
 * The caller is responsible for displaying warnings — this module never logs.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type { McpConfig, McpDefaults, McpServerConfig } from "./types.js";
import {
	DEFAULT_CONNECTION_TIMEOUT,
	DEFAULT_IDLE_TIMEOUT,
	DEFAULT_MAX_RESULT_SIZE,
	QUALIFIED_NAME_SEPARATOR,
} from "./constants.js";

// ─── Known fields (for unknown-field warnings) ────────────────────────────────

const KNOWN_TOP_LEVEL_FIELDS = new Set(["defaults", "servers"]);

const KNOWN_DEFAULTS_FIELDS = new Set([
	"connectionTimeout",
	"idleTimeout",
	"maxResultSize",
]);

const KNOWN_SERVER_FIELDS = new Set([
	"transport",
	"command",
	"args",
	"url",
	"headers",
	"env",
	"disabled",
	"lazyConnect",
	"connectionTimeout",
	"idleTimeout",
]);

// ─── File I/O result type ─────────────────────────────────────────────────────

type FileReadResult =
	| { kind: "missing" }
	| { kind: "ioError"; message: string }
	| { kind: "parseError"; message: string }
	| { kind: "ok"; data: unknown };

// ─── Intermediate parsed-defaults shape ───────────────────────────────────────

interface ParsedDefaults {
	connectionTimeout?: number;
	idleTimeout?: number;
	maxResultSize?: number;
}

// ─── File reading ─────────────────────────────────────────────────────────────

/**
 * Read and JSON-parse a file.
 * - Missing file → `{ kind: "missing" }` (not an error).
 * - IO error (permissions, etc.) → `{ kind: "ioError" }`.
 * - Invalid JSON → `{ kind: "parseError" }`.
 */
function readJsonFile(filePath: string): FileReadResult {
	let raw: string;
	try {
		raw = fs.readFileSync(filePath, "utf8");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return { kind: "missing" };
		}
		return {
			kind: "ioError",
			message: `Cannot read ${filePath}: ${(err as Error).message}`,
		};
	}
	try {
		return { kind: "ok", data: JSON.parse(raw) };
	} catch (err) {
		return {
			kind: "parseError",
			message: `JSON parse error in ${filePath}: ${(err as Error).message}`,
		};
	}
}

// ─── Environment-variable interpolation ──────────────────────────────────────

/** Pattern matching `${VAR_NAME}` placeholders */
const ENV_VAR_RE = /\$\{([^}]+)\}/g;

/**
 * Replace every `${VAR}` in `value` with the corresponding process.env value.
 * Unresolvable variables produce a warning and are left as-is.
 */
function interpolateString(value: string, warnings: string[]): string {
	return value.replace(ENV_VAR_RE, (_match, varName: string) => {
		const resolved = process.env[varName];
		if (resolved === undefined) {
			warnings.push(
				`Environment variable "${varName}" is not set (referenced in mcp.json). Using literal placeholder.`,
			);
			return _match;
		}
		return resolved;
	});
}

/**
 * Apply env-var interpolation to every value in a `Record<string, string>`.
 */
function interpolateRecord(
	record: Record<string, string>,
	warnings: string[],
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(record)) {
		out[k] = interpolateString(v, warnings);
	}
	return out;
}

// ─── String-record parsing helper ────────────────────────────────────────────

/**
 * Parse a raw `unknown` value as `Record<string, string>`.
 * Non-string values within the object are dropped with a warning.
 * A non-object value is ignored with a warning (returns undefined).
 */
function parseStringRecord(
	raw: unknown,
	fieldPath: string,
	warnings: string[],
): Record<string, string> | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push(`"${fieldPath}" must be an object. Ignoring.`);
		return undefined;
	}
	const obj = raw as Record<string, unknown>;
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(obj)) {
		if (typeof v !== "string") {
			warnings.push(`"${fieldPath}.${k}" must be a string. Ignoring.`);
		} else {
			out[k] = v;
		}
	}
	return out;
}

// ─── Defaults parsing ─────────────────────────────────────────────────────────

function parseDefaults(
	raw: unknown,
	filePath: string,
	warnings: string[],
): ParsedDefaults {
	if (raw === undefined) return {};
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push(`"defaults" in ${filePath} must be an object. Ignoring.`);
		return {};
	}
	const obj = raw as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		if (!KNOWN_DEFAULTS_FIELDS.has(key)) {
			warnings.push(
				`Unknown field "defaults.${key}" in ${filePath}. Ignoring.`,
			);
		}
	}
	const out: ParsedDefaults = {};
	if (typeof obj.connectionTimeout === "number")
		out.connectionTimeout = obj.connectionTimeout;
	if (typeof obj.idleTimeout === "number") out.idleTimeout = obj.idleTimeout;
	if (typeof obj.maxResultSize === "number")
		out.maxResultSize = obj.maxResultSize;
	return out;
}

/** Build a fully-resolved McpDefaults from a (possibly partial) ParsedDefaults */
function buildMcpDefaults(parsed: ParsedDefaults): McpDefaults {
	return {
		connectionTimeout: parsed.connectionTimeout ?? DEFAULT_CONNECTION_TIMEOUT,
		idleTimeout: parsed.idleTimeout ?? DEFAULT_IDLE_TIMEOUT,
		maxResultSize: parsed.maxResultSize ?? DEFAULT_MAX_RESULT_SIZE,
	};
}

// ─── Server definition parsing ────────────────────────────────────────────────

/**
 * Validate and build a single McpServerConfig from a raw JSON object.
 * Returns null if the server must be skipped (invalid required fields).
 */
function parseServerConfig(
	name: string,
	raw: unknown,
	filePath: string,
	warnings: string[],
): McpServerConfig | null {
	// Section 17: server names must not contain the qualified-name separator
	if (name.includes(QUALIFIED_NAME_SEPARATOR)) {
		warnings.push(
			`Server name "${name}" in ${filePath} contains "${QUALIFIED_NAME_SEPARATOR}" ` +
				`(reserved for qualified tool names). Skipping.`,
		);
		return null;
	}

	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		warnings.push(
			`Server "${name}" in ${filePath} must be an object. Skipping.`,
		);
		return null;
	}

	const obj = raw as Record<string, unknown>;

	// Warn on unknown fields (section 5.5)
	for (const key of Object.keys(obj)) {
		if (!KNOWN_SERVER_FIELDS.has(key)) {
			warnings.push(
				`Unknown field "${key}" in server "${name}" (${filePath}). Ignoring.`,
			);
		}
	}

	// Validate transport (section 5.5)
	const transport = obj.transport;
	if (transport !== "stdio" && transport !== "http") {
		const display =
			transport === undefined ? "(missing)" : JSON.stringify(transport);
		warnings.push(
			`Server "${name}" in ${filePath} has invalid transport ${display}. ` +
				`Must be "stdio" or "http". Skipping.`,
		);
		return null;
	}

	// ── Common optional fields ───────────────────────────────────────────────

	const rawEnv = parseStringRecord(
		obj.env,
		`servers.${name}.env`,
		warnings,
	);
	const env =
		rawEnv !== undefined ? interpolateRecord(rawEnv, warnings) : undefined;

	const disabled =
		typeof obj.disabled === "boolean" ? obj.disabled : undefined;
	const lazyConnect =
		typeof obj.lazyConnect === "boolean" ? obj.lazyConnect : undefined;
	const connectionTimeout =
		typeof obj.connectionTimeout === "number"
			? obj.connectionTimeout
			: undefined;
	const idleTimeout =
		typeof obj.idleTimeout === "number" ? obj.idleTimeout : undefined;

	// ── stdio transport ──────────────────────────────────────────────────────
	if (transport === "stdio") {
		if (typeof obj.command !== "string" || obj.command.trim() === "") {
			warnings.push(
				`Server "${name}" in ${filePath} (stdio) is missing required field "command". Skipping.`,
			);
			return null;
		}
		const command = obj.command;

		let args: string[] = [];
		if (obj.args !== undefined) {
			if (Array.isArray(obj.args)) {
				const badIndices: number[] = [];
				args = (obj.args as unknown[]).filter(
					(a, i): a is string => {
						if (typeof a === "string") return true;
						badIndices.push(i);
						return false;
					},
				);
				if (badIndices.length > 0) {
					warnings.push(
						`Server "${name}" in ${filePath}: args[${badIndices.join(", ")}] ` +
							`are not strings. Ignoring non-string entries.`,
					);
				}
			} else {
				warnings.push(
					`Server "${name}" in ${filePath}: "args" must be an array. Using empty args.`,
				);
			}
		}

		const config: McpServerConfig = {
			name,
			transport: "stdio",
			command,
			args,
		};
		if (env !== undefined) config.env = env;
		if (disabled !== undefined) config.disabled = disabled;
		if (lazyConnect !== undefined) config.lazyConnect = lazyConnect;
		if (connectionTimeout !== undefined)
			config.connectionTimeout = connectionTimeout;
		if (idleTimeout !== undefined) config.idleTimeout = idleTimeout;
		return config;
	}

	// ── http transport ───────────────────────────────────────────────────────
	if (typeof obj.url !== "string" || obj.url.trim() === "") {
		warnings.push(
			`Server "${name}" in ${filePath} (http) is missing required field "url". Skipping.`,
		);
		return null;
	}
	const url = interpolateString(obj.url, warnings);

	const rawHeaders = parseStringRecord(
		obj.headers,
		`servers.${name}.headers`,
		warnings,
	);
	const headers =
		rawHeaders !== undefined
			? interpolateRecord(rawHeaders, warnings)
			: undefined;

	const config: McpServerConfig = {
		name,
		transport: "http",
		url,
	};
	if (headers !== undefined) config.headers = headers;
	if (env !== undefined) config.env = env;
	if (disabled !== undefined) config.disabled = disabled;
	if (lazyConnect !== undefined) config.lazyConnect = lazyConnect;
	if (connectionTimeout !== undefined)
		config.connectionTimeout = connectionTimeout;
	if (idleTimeout !== undefined) config.idleTimeout = idleTimeout;
	return config;
}

// ─── Full config-file parsing ─────────────────────────────────────────────────

interface ParsedConfigFile {
	servers: Record<string, McpServerConfig>;
	defaults: ParsedDefaults;
}

/**
 * Parse and validate the contents of a single mcp.json file.
 * Returns null if the root value is not a JSON object (structural error).
 */
function parseConfigFile(
	data: unknown,
	filePath: string,
	warnings: string[],
): ParsedConfigFile | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) {
		warnings.push(
			`Config file ${filePath} root must be a JSON object. Ignoring this file.`,
		);
		return null;
	}
	const obj = data as Record<string, unknown>;

	// Warn on unknown top-level fields
	for (const key of Object.keys(obj)) {
		if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
			warnings.push(
				`Unknown top-level field "${key}" in ${filePath}. Ignoring.`,
			);
		}
	}

	const defaults = parseDefaults(obj.defaults, filePath, warnings);

	const servers: Record<string, McpServerConfig> = {};
	if (obj.servers !== undefined) {
		if (
			typeof obj.servers === "object" &&
			obj.servers !== null &&
			!Array.isArray(obj.servers)
		) {
			const rawServers = obj.servers as Record<string, unknown>;
			for (const [serverName, serverDef] of Object.entries(rawServers)) {
				const config = parseServerConfig(
					serverName,
					serverDef,
					filePath,
					warnings,
				);
				if (config !== null) {
					servers[serverName] = config;
				}
			}
		} else {
			warnings.push(`"servers" in ${filePath} must be an object. Ignoring.`);
		}
	}

	return { servers, defaults };
}

// ─── Empty / disabled config ──────────────────────────────────────────────────

function emptyConfig(): McpConfig {
	return {
		servers: {},
		defaults: {
			connectionTimeout: DEFAULT_CONNECTION_TIMEOUT,
			idleTimeout: DEFAULT_IDLE_TIMEOUT,
			maxResultSize: DEFAULT_MAX_RESULT_SIZE,
		},
	};
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Save MCP server configuration to disk.
 *
 * Writes the `servers` record (plus current defaults) to either the
 * project-local `.pi/mcp.json` or the global `~/.pi/agent/mcp.json`.
 * Creates parent directories as needed. Does not touch the other scope's file.
 *
 * @param cwd      Working directory (used to resolve project-local path)
 * @param config   The full McpConfig to persist (servers + defaults)
 * @param scope    Which config file to write: "local" or "global"
 */
export function saveConfig(
	cwd: string,
	config: McpConfig,
	scope: "local" | "global",
): void {
	const filePath =
		scope === "local"
			? path.join(cwd, ".pi", "mcp.json")
			: path.join(os.homedir(), ".pi", "agent", "mcp.json");

	// Build the raw JSON structure (strip the runtime `name` field from each server
	// since the name is the key in the JSON object).
	const rawServers: Record<string, Record<string, unknown>> = {};
	for (const [name, server] of Object.entries(config.servers)) {
		const { name: _name, ...rest } = server;
		rawServers[name] = rest;
	}

	const jsonObj: Record<string, unknown> = { servers: rawServers };

	// Only include defaults if they differ from the built-in defaults.
	const d = config.defaults;
	const hasCustomDefaults =
		(d.connectionTimeout !== undefined &&
			d.connectionTimeout !== DEFAULT_CONNECTION_TIMEOUT) ||
		(d.idleTimeout !== undefined &&
			d.idleTimeout !== DEFAULT_IDLE_TIMEOUT) ||
		(d.maxResultSize !== undefined &&
			d.maxResultSize !== DEFAULT_MAX_RESULT_SIZE);

	if (hasCustomDefaults) {
		jsonObj.defaults = d;
	}

	const dir = path.dirname(filePath);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(filePath, JSON.stringify(jsonObj, null, 2) + "\n", "utf8");
}

/**
 * Load and merge MCP configuration from:
 *   1. `~/.pi/agent/mcp.json`  (global)
 *   2. `<cwd>/.pi/mcp.json`    (project-local — overrides global)
 *
 * Merge rules:
 * - Project-local server definitions override global ones with the same name.
 * - Servers only in the global file are kept as-is.
 * - Defaults are also merged: project-local values override global values.
 *
 * JSON parse errors in either file disable MCP entirely (returns empty config).
 * All other issues (unknown fields, missing required fields, etc.) produce
 * warnings but allow the remaining valid configuration to be used.
 *
 * @param cwd  Working directory used to resolve `.pi/mcp.json`
 * @returns    `{ config, warnings }` — warnings are informational strings the
 *             caller should surface to the user.
 */
export function loadConfig(cwd: string): {
	config: McpConfig;
	warnings: string[];
} {
	const warnings: string[] = [];

	const globalPath = path.join(os.homedir(), ".pi", "agent", "mcp.json");
	const localPath = path.join(cwd, ".pi", "mcp.json");

	// ── Load global config ──────────────────────────────────────────────────

	let globalParsed: ParsedConfigFile | null = null;
	const globalResult = readJsonFile(globalPath);

	if (globalResult.kind === "parseError") {
		warnings.push(`${globalResult.message}. MCP disabled.`);
		return { config: emptyConfig(), warnings };
	} else if (globalResult.kind === "ioError") {
		warnings.push(
			`${globalResult.message}. Global MCP config will be skipped.`,
		);
	} else if (globalResult.kind === "ok") {
		globalParsed = parseConfigFile(globalResult.data, globalPath, warnings);
	}
	// kind === "missing" → no global config, that is fine

	// ── Load project-local config ──────────────────────────────────────────

	let localParsed: ParsedConfigFile | null = null;
	const localResult = readJsonFile(localPath);

	if (localResult.kind === "parseError") {
		warnings.push(`${localResult.message}. MCP disabled.`);
		return { config: emptyConfig(), warnings };
	} else if (localResult.kind === "ioError") {
		warnings.push(
			`${localResult.message}. Project-local MCP config will be skipped.`,
		);
	} else if (localResult.kind === "ok") {
		localParsed = parseConfigFile(localResult.data, localPath, warnings);
	}
	// kind === "missing" → no local config, that is fine

	// ── Merge servers: global first, then local overrides ──────────────────

	const mergedServers: Record<string, McpServerConfig> = {
		...(globalParsed?.servers ?? {}),
	};

	const localServers = localParsed?.servers ?? {};
	for (const [name, serverConfig] of Object.entries(localServers)) {
		if (Object.prototype.hasOwnProperty.call(mergedServers, name)) {
			warnings.push(
				`Duplicate server name "${name}" found in both global and project-local mcp.json. ` +
					`Project-local definition wins.`,
			);
		}
		mergedServers[name] = serverConfig;
	}

	// ── Merge defaults: global first, local overrides ──────────────────────

	const mergedRawDefaults: ParsedDefaults = {
		...(globalParsed?.defaults ?? {}),
		...(localParsed?.defaults ?? {}),
	};
	const defaults = buildMcpDefaults(mergedRawDefaults);

	return {
		config: { servers: mergedServers, defaults },
		warnings,
	};
}
