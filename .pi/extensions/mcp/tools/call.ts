/**
 * MCP Gateway Extension — mcp_call Tool
 *
 * Proxy tool that lets the agent invoke any tool on any configured MCP server.
 * The agent discovers the qualified name via mcp_search, then passes it here along
 * with the required arguments. Validation of the argument schema is left to the
 * MCP server; this tool forwards the call as-is and maps the response back into
 * pi's content format.
 *
 * Export: factory function so the caller can inject the live pool and config
 * instances — both are unavailable at module load time.
 */

import type { ToolDefinition } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";

import { DEFAULT_CALL_TIMEOUT, DEFAULT_MAX_RESULT_SIZE, QUALIFIED_NAME_SEPARATOR } from "../constants.js";
import type { McpClientPool } from "../pool.js";
import type { McpConfig } from "../types.js";

// ─── Parameter Schema ─────────────────────────────────────────────────────────

const callParams = Type.Object({
	tool: Type.String({
		description:
			'Qualified name of the MCP tool to call. Format: "serverName__toolName" (double underscore separator). ' +
			"Obtain this from mcp_search results before calling.",
	}),
	arguments: Type.Record(Type.String(), Type.Unknown(), {
		description:
			"Arguments to pass to the MCP tool as a free-form JSON object. " +
			"The MCP server validates the argument schema; this tool forwards them as-is.",
	}),
});

// ─── Factory ──────────────────────────────────────────────────────────────────

/**
 * Create the mcp_call ToolDefinition.
 *
 * @param pool   - Live MCP client pool for lazy-connect and tool invocation.
 * @param config - Merged MCP configuration for server validation and size limits.
 */
export function createCallTool(
	pool: McpClientPool,
	config: McpConfig,
): ToolDefinition<typeof callParams, undefined> {
	return {
		name: "mcp_call",
		label: "MCP Call",
		description:
			"Call an MCP tool by its qualified name (serverName__toolName). " +
			"Use mcp_search first to discover available tools and their qualified names. " +
			"Arguments are forwarded to the MCP server as-is; the server validates the schema.",
		parameters: callParams,
		sideEffects: true,

		renderCall(args, _options, theme) {
			let text = theme.fg("toolTitle", theme.bold("mcp_call "));
			text += theme.fg("accent", args.tool);
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme) {
			if (result.isError) {
				const errorText = result.content[0];
				return new Text(
					theme.fg("error", errorText?.type === "text" ? errorText.text : "Failed"),
					0, 0,
				);
			}

			const textContent = result.content.filter(
				(c): c is { type: "text"; text: string } => c.type === "text",
			);
			const totalLines = textContent.reduce((n, c) => n + c.text.split("\n").length, 0);

			let text = theme.fg("success", `${totalLines} line${totalLines !== 1 ? "s" : ""}`);

			if (expanded) {
				for (const c of textContent) {
					const lines = c.text.split("\n");
					const preview = lines.slice(0, 20);
					for (const line of preview) {
						text += `\n${theme.fg("dim", line)}`;
					}
					if (lines.length > 20) {
						text += `\n${theme.fg("muted", `... ${lines.length - 20} more lines`)}`;
					}
				}
			}

			return new Text(text, 0, 0);
		},

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const { tool: qualifiedName, arguments: toolArgs } = params;

			// ── Step 1: Parse qualified name ───────────────────────────────────────
			const separatorIndex = qualifiedName.indexOf(QUALIFIED_NAME_SEPARATOR);
			const hasSeparator = separatorIndex !== -1;
			const hasServerName = hasSeparator && separatorIndex > 0;
			const hasToolName =
				hasSeparator && separatorIndex + QUALIFIED_NAME_SEPARATOR.length < qualifiedName.length;

			if (!hasSeparator || !hasServerName || !hasToolName) {
				throw new Error(
					`Invalid tool name format. Expected: serverName${QUALIFIED_NAME_SEPARATOR}toolName`,
				);
			}

			const serverName = qualifiedName.slice(0, separatorIndex);
			const toolName = qualifiedName.slice(separatorIndex + QUALIFIED_NAME_SEPARATOR.length);

			// ── Step 2: Validate server exists in config ───────────────────────────
			if (!(serverName in config.servers)) {
				const available = Object.keys(config.servers).join(", ");
				throw new Error(
					`Unknown MCP server: ${serverName}. Available servers: ${available || "(none)"}`,
				);
			}

			// ── Step 3 + 4: Connect (lazy) and invoke tool via pool ────────────────
			let mcpResult: Awaited<ReturnType<McpClientPool["callTool"]>>;
			try {
				mcpResult = await pool.callTool(serverName, toolName, toolArgs);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);

				// Timeout — error message already formatted by the pool.
				if (message.includes("timed out after") && message.includes("ms")) {
					throw new Error(message);
				}

				// Tool not found at the protocol level (MCP error response, not tool result).
				const lowerMessage = message.toLowerCase();
				if (
					lowerMessage.includes("unknown tool") ||
					(lowerMessage.includes("not found") && lowerMessage.includes(toolName.toLowerCase()))
				) {
					throw new Error(`Tool '${toolName}' not found on server '${serverName}'`);
				}

				// Everything else is a connection or protocol failure.
				throw new Error(`Failed to connect to MCP server '${serverName}': ${message}`);
			}

			// ── Step 5: Format result content ──────────────────────────────────────
			const maxResultSize = config.defaults.maxResultSize ?? DEFAULT_MAX_RESULT_SIZE;

			// Accumulate pi content blocks, tracking text byte totals for truncation.
			const piContent: Array<
				{ type: "text"; text: string } | { type: "image"; data: string; mimeType: string }
			> = [];
			let totalTextBytes = 0;
			let truncated = false;

			for (const item of mcpResult.content) {
				if (truncated) break;

				if (item.type === "text") {
					// ── text content ──
					const textBytes = Buffer.byteLength(item.text, "utf8");

					if (totalTextBytes + textBytes <= maxResultSize) {
						piContent.push({ type: "text" as const, text: item.text });
						totalTextBytes += textBytes;
					} else {
						// Truncate: keep as many bytes as fit, then append notice.
						const remaining = maxResultSize - totalTextBytes;
						if (remaining > 0) {
							// Slice on byte boundary — Buffer.from converts, then back to string.
							const buf = Buffer.from(item.text, "utf8");
							const truncatedText = buf.subarray(0, remaining).toString("utf8");
							piContent.push({ type: "text" as const, text: truncatedText });
						}
						const omittedBytes = textBytes - Math.max(0, maxResultSize - totalTextBytes);
						const totalBytes = totalTextBytes + textBytes;
						piContent.push({
							type: "text" as const,
							text:
								`\n[Output truncated: ${omittedBytes} bytes omitted. ` +
								`Total size: ${totalBytes} bytes, limit: ${maxResultSize} bytes]`,
						});
						truncated = true;
					}
				} else if (item.type === "image") {
					// ── image content — not counted against the text size limit ──
					piContent.push({
						type: "image" as const,
						data: item.data,
						mimeType: item.mimeType,
					});
				} else if (item.type === "resource") {
					// ── embedded resource — serialise to text ──
					const res = item.resource;
					let resourceText: string;
					if ("text" in res) {
						resourceText = `Resource: ${res.uri}\n${res.text}`;
					} else {
						resourceText = `Resource: ${res.uri}\n[Binary blob, mimeType: ${res.mimeType ?? "unknown"}]`;
					}

					const textBytes = Buffer.byteLength(resourceText, "utf8");
					if (totalTextBytes + textBytes <= maxResultSize) {
						piContent.push({ type: "text" as const, text: resourceText });
						totalTextBytes += textBytes;
					} else {
						const remaining = maxResultSize - totalTextBytes;
						if (remaining > 0) {
							const buf = Buffer.from(resourceText, "utf8");
							const truncatedText = buf.subarray(0, remaining).toString("utf8");
							piContent.push({ type: "text" as const, text: truncatedText });
						}
						const omittedBytes = textBytes - Math.max(0, maxResultSize - totalTextBytes);
						const totalBytes = totalTextBytes + textBytes;
						piContent.push({
							type: "text" as const,
							text:
								`\n[Output truncated: ${omittedBytes} bytes omitted. ` +
								`Total size: ${totalBytes} bytes, limit: ${maxResultSize} bytes]`,
						});
						truncated = true;
					}
				}
				// AudioContent, ResourceLink, and other future content types: silently ignored.
			}

			// ── Step 5 (continued): MCP-level tool error ───────────────────────────
			if (mcpResult.isError === true) {
				// Preserve the formatted content in the error so the agent can see what went wrong.
				const errorText = piContent
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join("\n")
					.trim();

				// Detect "tool not found" in the MCP error response body.
				const lowerErrorText = errorText.toLowerCase();
				if (
					lowerErrorText.includes("unknown tool") ||
					(lowerErrorText.includes("not found") && lowerErrorText.includes(toolName.toLowerCase()))
				) {
					throw new Error(`Tool '${toolName}' not found on server '${serverName}'`);
				}

				throw new Error(
					errorText || `Tool '${toolName}' returned an error on server '${serverName}'`,
				);
			}

			return { content: piContent, details: undefined };
		},
	};
}

// Re-export timeout constant for use in index.ts if needed.
export { DEFAULT_CALL_TIMEOUT };
