/**
 * MCP Gateway Extension — System Prompt Builder
 *
 * Generates the MCP informational text appended to the system prompt each turn.
 * Tells the agent which MCP servers are available and how to use mcp_search /
 * mcp_call to discover and invoke their tools.
 *
 * Returns an empty string when no active servers are configured (section 10.3).
 */

import type { McpConfig } from "./types.js";

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Build the MCP system-prompt addition for the given configuration.
 *
 * If no servers are configured, or every server has `disabled: true`, returns
 * an empty string so nothing is appended to the system prompt.
 *
 * @param config  Parsed and merged MCP configuration.
 * @returns       Informational text to append to the system prompt, or `""`.
 */
export function buildMcpSystemPrompt(config: McpConfig): string {
	const activeServers = Object.values(config.servers).filter(
		(s) => s.disabled !== true,
	);

	// Section 10.3 — conditional inclusion
	if (activeServers.length === 0) {
		return "";
	}

	const serverLines = activeServers
		.map((s) => `  - ${s.name}`)
		.join("\n");

	return `\
## MCP Tool Ecosystem

You have access to external tools provided by MCP (Model Context Protocol) servers. \
Use the two meta-tools below to discover and invoke them.

### Configured MCP Servers
${serverLines}

### mcp_search — Discover tools
Use \`mcp_search\` to find tools by keyword or natural language before calling them.

Parameters:
- \`query\` (required): keyword or natural-language description of what you need
  (e.g. "list github issues", "send slack message", "run database query")
- \`server\` (optional): restrict results to a specific server name
- \`refresh\` (optional, boolean): re-fetch the tool catalog from all servers before searching

### mcp_call — Invoke a tool
Use \`mcp_call\` to invoke any tool returned by \`mcp_search\`.

Parameters:
- \`tool\` (required): the qualified tool name in the format \`serverName__toolName\`
  (double-underscore separator, e.g. \`github__search_repositories\`)
- \`arguments\` (required): JSON object of tool arguments as described in the search result

### Qualified Name Format
Every MCP tool is identified by a qualified name: \`serverName__toolName\`
(double underscore). The server name comes first, followed by two underscores,
then the tool name as reported by the MCP server. Use exactly this string as the
\`tool\` argument to \`mcp_call\`.

### Recommended Workflow
1. Call \`mcp_search\` with a descriptive query to find the right tool.
2. Review the returned qualified name and parameter list.
3. Call \`mcp_call\` with the qualified name and appropriate arguments.
`;
}
