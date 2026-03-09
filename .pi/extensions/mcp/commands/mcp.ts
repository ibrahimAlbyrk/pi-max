/**
 * MCP Gateway Extension — /mcp Command
 *
 * Interactive overlay panel for managing MCP server connections.
 * Invoked via /mcp slash command, showing a SelectList of all configured
 * servers with live status indicators and keyboard-driven actions.
 */

import { Container, Key, matchesKey, type SelectItem, SelectList, Text } from "@mariozechner/pi-tui";
import { DynamicBorder } from "@mariozechner/pi-coding-agent";
import type {
	ExtensionCommandContext,
	QuestionDialogConfig,
	QuestionAnswer,
	RegisteredCommand,
} from "@mariozechner/pi-coding-agent";
import type { ToolCatalog } from "../catalog.js";
import type { McpClientPool } from "../pool.js";
import type { McpConfig, McpServerConfig } from "../types.js";
import { QUALIFIED_NAME_SEPARATOR } from "../constants.js";

// ─── Public Interface ─────────────────────────────────────────────────────────

/** Dependencies injected from the extension entry point via closure. */
export interface McpCommandDeps {
	/** Returns the current MCP configuration, or null if not yet loaded. */
	getConfig(): McpConfig | null;
	/** Returns the active client pool, or null if no session has started. */
	getPool(): McpClientPool | null;
	/** Returns the shared in-memory tool catalog. */
	getCatalog(): ToolCatalog;
	/** Persist updated config to disk and trigger an extension reload. */
	saveAndReload(ctx: ExtensionCommandContext, config: McpConfig, scope: "local" | "global"): Promise<void>;
	/** Disconnect then reconnect a single server by name. */
	reconnectServer(serverName: string): Promise<void>;
}

// ─── Factory ─────────────────────────────────────────────────────────────────

/**
 * Create the /mcp command, binding the provided dependency accessors.
 */
export function createMcpCommand(deps: McpCommandDeps): RegisteredCommand {
	return {
		name: "mcp",
		description: "Manage MCP server connections",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify("No UI available", "error");
				return;
			}

			const config = deps.getConfig();
			if (!config) {
				ctx.ui.notify("No MCP configuration loaded. Start a session first.", "info");
				return;
			}

			let shouldLoop = true;
			while (shouldLoop) {
				const latestConfig = deps.getConfig() ?? config;
				const action = await showMcpPanel(ctx, deps, latestConfig);

				switch (action.type) {
					case "close":
						shouldLoop = false;
						break;

					case "add":
						await handleAdd(ctx, deps, latestConfig);
						shouldLoop = false;
						break;

					case "toggle": {
						const server = latestConfig.servers[action.serverName];
						if (!server) break;
						const nowDisabled = !server.disabled;
						const newServer: McpServerConfig = { ...server };
						if (nowDisabled) {
							newServer.disabled = true;
						} else {
							delete newServer.disabled;
						}
						const newConfig: McpConfig = {
							...latestConfig,
							servers: { ...latestConfig.servers, [action.serverName]: newServer },
						};
						await deps.saveAndReload(ctx, newConfig, "local");
						ctx.ui.notify(
							`Server "${action.serverName}" ${nowDisabled ? "disabled" : "enabled"}`,
							"info",
						);
						shouldLoop = false;
						break;
					}

					case "reconnect":
						try {
							await deps.reconnectServer(action.serverName);
							ctx.ui.notify(`Reconnected to "${action.serverName}"`, "info");
						} catch (err) {
							ctx.ui.notify(
								`Failed to reconnect "${action.serverName}": ${err instanceof Error ? err.message : String(err)}`,
								"error",
							);
						}
						shouldLoop = false;
						break;

					case "delete": {
						const confirmed = await ctx.ui.confirm(
							"Delete Server",
							`Remove "${action.serverName}" from MCP configuration?`,
						);
						if (!confirmed) break;
						const { [action.serverName]: _removed, ...remaining } = latestConfig.servers;
						const newConfig: McpConfig = { ...latestConfig, servers: remaining };
						await deps.saveAndReload(ctx, newConfig, "local");
						ctx.ui.notify(`Server "${action.serverName}" removed`, "info");
						shouldLoop = false;
						break;
					}

					case "details": {
						const detailResult = await showDetailsPanel(ctx, deps, latestConfig, action.serverName);
						if (detailResult === "close-all") {
							shouldLoop = false;
						}
						// "back" → loop continues, re-shows main panel
						break;
					}
				}
			}
		},
	};
}

// ─── Panel Action Union ───────────────────────────────────────────────────────

type PanelAction =
	| { type: "close" }
	| { type: "add" }
	| { type: "toggle"; serverName: string }
	| { type: "reconnect"; serverName: string }
	| { type: "delete"; serverName: string }
	| { type: "details"; serverName: string };

// ─── Main Server Panel ────────────────────────────────────────────────────────

async function showMcpPanel(
	ctx: ExtensionCommandContext,
	deps: McpCommandDeps,
	config: McpConfig,
): Promise<PanelAction> {
	return ctx.ui.custom<PanelAction>(
		(tui, theme, _kb, done) => {
			const pool = deps.getPool();
			const catalog = deps.getCatalog();
			const serverNames = Object.keys(config.servers);

			// Build SelectList items — one per configured server.
			const items: SelectItem[] = serverNames.map((name) => {
				const server = config.servers[name];
				const isDisabled = server.disabled === true;

				// Status indicator
				let statusIcon: string;
				if (isDisabled) {
					statusIcon = theme.fg("warning", "◌");
				} else if (pool) {
					const state = pool.getStatus(name);
					if (state === "connected") {
						statusIcon = theme.fg("success", "●");
					} else if (state === "error") {
						statusIcon = theme.fg("error", "✗");
					} else {
						statusIcon = theme.fg("dim", "○");
					}
				} else {
					statusIcon = theme.fg("dim", "○");
				}

				// Tool count from in-memory catalog (empty string → "0" matches everything).
				const toolCount = catalog.search("", { server: name, limit: 9999 }).length;
				const toolStr = toolCount > 0 ? `${toolCount} tools` : "0 tools";

				const transport = theme.fg("dim", server.transport);
				const tools = theme.fg("muted", toolStr);

				const label = `${statusIcon} ${theme.bold(name)}  ${transport}  ${tools}`;
				return { value: name, label };
			});

			const maxVisible = Math.min(Math.max(serverNames.length, 1), 10);

			const selectList = new SelectList(items, maxVisible, {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => t,
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});

			// Enter → show details for selected server.
			selectList.onSelect = (item) => done({ type: "details", serverName: item.value });
			// Escape handled below; but SelectList.onCancel is also triggered by Escape internally.
			selectList.onCancel = () => done({ type: "close" });

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold(" MCP Servers")), 0, 0),
			);

			if (serverNames.length === 0) {
				container.addChild(
					new Text(
						theme.fg("muted", "  No servers configured. Press [a] to add one."),
						0,
						0,
					),
				);
			} else {
				container.addChild(selectList);
			}

			container.addChild(
				new Text(
					theme.fg(
						"dim",
						" [a]dd  [t]oggle  [r]econnect  [d]elete  [enter]details  [esc]close",
					),
					0,
					0,
				),
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					// Escape always closes.
					if (matchesKey(data, Key.escape)) {
						done({ type: "close" });
						return;
					}

					// Add server — closes panel first, then wizard runs.
					if (data === "a" || data === "A") {
						done({ type: "add" });
						return;
					}

					const selected = selectList.getSelectedItem();

					if (data === "t" || data === "T") {
						if (selected) done({ type: "toggle", serverName: selected.value });
						return;
					}

					if (data === "r" || data === "R") {
						if (selected) done({ type: "reconnect", serverName: selected.value });
						return;
					}

					if (data === "d" || data === "D") {
						if (selected) done({ type: "delete", serverName: selected.value });
						return;
					}

					// Delegate navigation and Enter to SelectList.
					if (serverNames.length > 0) {
						selectList.handleInput(data);
					}
					tui.requestRender();
				},
			};
		},
	);
}

// ─── Details Panel ────────────────────────────────────────────────────────────

type DetailsAction = "close-all" | "back" | "browse-tools";

async function showDetailsPanel(
	ctx: ExtensionCommandContext,
	deps: McpCommandDeps,
	config: McpConfig,
	serverName: string,
): Promise<"close-all" | "back"> {
	const server = config.servers[serverName];
	if (!server) return "back";

	const pool = deps.getPool();
	const catalog = deps.getCatalog();

	const action = await ctx.ui.custom<DetailsAction>(
		(tui, theme, _kb, done) => {
			const state = pool ? pool.getStatus(serverName) : "disconnected";
			const isDisabled = server.disabled === true;

			let stateDisplay: string;
			if (isDisabled) {
				stateDisplay = theme.fg("warning", "disabled");
			} else {
				switch (state) {
					case "connected":
						stateDisplay = theme.fg("success", "connected");
						break;
					case "error":
						stateDisplay = theme.fg("error", "error");
						break;
					case "connecting":
						stateDisplay = theme.fg("warning", "connecting");
						break;
					default:
						stateDisplay = theme.fg("dim", "disconnected");
						break;
				}
			}

			const tools = catalog.search("", { server: serverName, limit: 9999 });
			const toolCount = tools.length;

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold(` ${serverName}`)), 0, 0),
			);
			container.addChild(
				new Text(theme.fg("dim", `${"─".repeat(40)}`), 0, 0),
			);

			// Transport
			container.addChild(
				new Text(
					theme.fg("dim", " Transport:  ") + server.transport,
					0,
					0,
				),
			);

			// Transport-specific connection details
			if (server.transport === "stdio") {
				const cmdLine = [server.command, ...server.args].join(" ");
				container.addChild(
					new Text(theme.fg("dim", " Command:    ") + cmdLine, 0, 0),
				);
			} else {
				container.addChild(
					new Text(theme.fg("dim", " URL:        ") + server.url, 0, 0),
				);
				if (server.headers && Object.keys(server.headers).length > 0) {
					const headerKeys = Object.keys(server.headers).join(", ");
					container.addChild(
						new Text(theme.fg("dim", " Headers:    ") + headerKeys, 0, 0),
					);
				}
			}

			// Connection state
			container.addChild(
				new Text(theme.fg("dim", " Status:     ") + stateDisplay, 0, 0),
			);

			// Tool count (with hint to browse)
			const toolsLabel = toolCount > 0
				? `${toolCount}` + theme.fg("muted", "  [enter] browse tools")
				: theme.fg("muted", "none in catalog");
			container.addChild(
				new Text(theme.fg("dim", " Tools:      ") + toolsLabel, 0, 0),
			);

			// Env vars
			if (server.env && Object.keys(server.env).length > 0) {
				const envKeys = Object.keys(server.env).join(", ");
				container.addChild(
					new Text(theme.fg("dim", " Env vars:   ") + envKeys, 0, 0),
				);
			}

			// Timeouts (only if overridden)
			if (server.connectionTimeout !== undefined) {
				container.addChild(
					new Text(
						theme.fg("dim", " Conn. timeout: ") + `${server.connectionTimeout}ms`,
						0,
						0,
					),
				);
			}
			if (server.idleTimeout !== undefined) {
				container.addChild(
					new Text(
						theme.fg("dim", " Idle timeout:  ") + `${server.idleTimeout}ms`,
						0,
						0,
					),
				);
			}

			container.addChild(new Text(theme.fg("dim", `${"─".repeat(40)}`), 0, 0));
			container.addChild(new Text(theme.fg("dim", " [enter] browse tools  [bs] back  [esc] close"), 0, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					if (matchesKey(data, Key.escape)) {
						done("close-all");
						return;
					}
					if (matchesKey(data, Key.backspace) || data === "\x7f") {
						done("back");
						return;
					}
					if (matchesKey(data, Key.enter)) {
						done(toolCount > 0 ? "browse-tools" : "back");
						return;
					}
					tui.requestRender();
				},
			};
		},
	);

	if (action === "browse-tools") {
		const toolAction = await showToolBrowser(ctx, deps, serverName);
		if (toolAction === "close-all") return "close-all";
		// "back" from tool browser returns to details — re-show
		return showDetailsPanel(ctx, deps, config, serverName);
	}
	return action; // "back" or "close-all"
}

// ─── Tool Browser ─────────────────────────────────────────────────────────────

async function showToolBrowser(
	ctx: ExtensionCommandContext,
	deps: McpCommandDeps,
	serverName: string,
	initialIndex = 0,
): Promise<"close-all" | "back"> {
	const catalog = deps.getCatalog();
	const tools = catalog.search("", { server: serverName, limit: 9999 });

	if (tools.length === 0) {
		ctx.ui.notify("No tools in catalog for this server", "info");
		return "back";
	}

	type ToolBrowserAction = { type: "close-all" } | { type: "back" } | { type: "detail"; toolName: string; index: number };

	const action = await ctx.ui.custom<ToolBrowserAction>(
		(tui, theme, _kb, done) => {
			const items: SelectItem[] = tools.map((t) => ({
				value: t.toolName,
				label: ` ${theme.bold(t.toolName)}`,
				description: t.description
					? (t.description.length > 70 ? t.description.slice(0, 67) + "..." : t.description)
					: undefined,
			}));

			const maxVisible = Math.min(tools.length, 10);

			const selectList = new SelectList(items, maxVisible, {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => t,
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});

			selectList.setSelectedIndex(initialIndex);
			selectList.onSelect = (item) => {
				const idx = tools.findIndex((t) => t.toolName === item.value);
				done({ type: "detail", toolName: item.value, index: idx >= 0 ? idx : 0 });
			};
			selectList.onCancel = () => done({ type: "close-all" });

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold(` ${serverName}`)) +
						theme.fg("dim", ` — ${tools.length} tools`),
					0,
					0,
				),
			);
			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", " [enter] details  [bs] back  [esc] close"), 0, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					if (matchesKey(data, Key.escape)) {
						done({ type: "close-all" });
						return;
					}
					if (matchesKey(data, Key.backspace) || data === "\x7f") {
						done({ type: "back" });
						return;
					}
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		},
	);

	if (action.type === "detail") {
		const detailResult = await showToolDetail(ctx, catalog, serverName, action.toolName);
		if (detailResult === "close-all") return "close-all";
		// "back" from tool detail returns to tool browser at same position
		return showToolBrowser(ctx, deps, serverName, action.index);
	}
	return action.type; // "close-all" or "back"
}

// ─── Tool Detail ──────────────────────────────────────────────────────────────

async function showToolDetail(
	ctx: ExtensionCommandContext,
	catalog: ToolCatalog,
	serverName: string,
	toolName: string,
): Promise<"close-all" | "back"> {
	const tools = catalog.search("", { server: serverName, limit: 9999 });
	const tool = tools.find((t) => t.toolName === toolName);
	if (!tool) return "back";

	return ctx.ui.custom<"close-all" | "back">(
		(tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold(` ${tool.qualifiedName}`)), 0, 0),
			);
			container.addChild(
				new Text(theme.fg("dim", `${"─".repeat(40)}`), 0, 0),
			);

			// Description — wrap long text
			if (tool.description) {
				const descLines = wrapText(tool.description, 70);
				for (const line of descLines) {
					container.addChild(new Text(` ${line}`, 0, 0));
				}
			} else {
				container.addChild(new Text(theme.fg("muted", " (no description)"), 0, 0));
			}

			container.addChild(new Text("", 0, 0));

			// Parameters — use rich info if available, fall back to names
			if (tool.parameters && tool.parameters.length > 0) {
				container.addChild(
					new Text(theme.fg("dim", " Parameters:"), 0, 0),
				);
				for (const param of tool.parameters) {
					const req = param.required ? theme.fg("error", "*") : " ";
					const typeStr = theme.fg("dim", param.type);
					container.addChild(
						new Text(`  ${req} ${theme.fg("accent", param.name)} ${typeStr}`, 0, 0),
					);
					if (param.description) {
						const descLines = wrapText(param.description, 64);
						for (const line of descLines) {
							container.addChild(
								new Text(`      ${theme.fg("muted", line)}`, 0, 0),
							);
						}
					}
				}
			} else if (tool.parameterSummary.length > 0) {
				container.addChild(
					new Text(theme.fg("dim", " Parameters:"), 0, 0),
				);
				for (const param of tool.parameterSummary) {
					container.addChild(
						new Text(`   ${theme.fg("accent", param)}`, 0, 0),
					);
				}
			} else {
				container.addChild(
					new Text(theme.fg("dim", " Parameters: ") + theme.fg("muted", "none"), 0, 0),
				);
			}

			container.addChild(new Text(theme.fg("dim", `${"─".repeat(40)}`), 0, 0));
			container.addChild(new Text(theme.fg("dim", " [bs] back  [esc] close"), 0, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					if (matchesKey(data, Key.escape)) {
						done("close-all");
						return;
					}
					if (matchesKey(data, Key.backspace) || data === "\x7f" || matchesKey(data, Key.enter)) {
						done("back");
						return;
					}
					tui.requestRender();
				},
			};
		},
	);
}

/** Simple word-wrap for plain text */
function wrapText(text: string, maxWidth: number): string[] {
	const words = text.split(/\s+/);
	const lines: string[] = [];
	let current = "";
	for (const word of words) {
		if (current.length + word.length + 1 > maxWidth && current.length > 0) {
			lines.push(current);
			current = word;
		} else {
			current = current ? `${current} ${word}` : word;
		}
	}
	if (current) lines.push(current);
	return lines;
}

// ─── Add Server Wizard ────────────────────────────────────────────────────────

async function handleAdd(
	ctx: ExtensionCommandContext,
	deps: McpCommandDeps,
	config: McpConfig,
): Promise<void> {
	// ── Step 1: Collect server name and transport type ────────────────────────

	const step1Config: QuestionDialogConfig = {
		title: "Add MCP Server (1/2)",
		pages: [
			{
				title: "Name",
				prompt: "Server name:",
				mode: { type: "input", placeholder: "e.g. github" },
			},
			{
				title: "Transport",
				prompt: "Transport type:",
				mode: {
					type: "single-select",
					options: [
						{
							value: "stdio",
							label: "stdio",
							description: "Spawn a local process (command + args)",
						},
						{
							value: "http",
							label: "http",
							description: "Connect to a remote HTTP endpoint (URL)",
						},
					],
				},
			},
		],
	};

	const result1 = await ctx.ui.question(step1Config);
	if (!result1.completed) return;

	const nameAnswer: QuestionAnswer | null = result1.answers[0] ?? null;
	const transportAnswer: QuestionAnswer | null = result1.answers[1] ?? null;

	if (!nameAnswer || nameAnswer.type !== "input") return;
	if (!transportAnswer || transportAnswer.type !== "single-select") return;

	const name = nameAnswer.value.trim();
	const transport = transportAnswer.value as "stdio" | "http";

	if (!name) {
		ctx.ui.notify("Server name cannot be empty", "error");
		return;
	}

	// Validate: name must not contain the qualified-name separator.
	if (name.includes(QUALIFIED_NAME_SEPARATOR)) {
		ctx.ui.notify(
			`Server name cannot contain "${QUALIFIED_NAME_SEPARATOR}" (reserved separator)`,
			"error",
		);
		return;
	}

	if (config.servers[name] !== undefined) {
		ctx.ui.notify(`Server "${name}" already exists`, "error");
		return;
	}

	// ── Step 2: Transport-specific details ────────────────────────────────────

	if (transport === "stdio") {
		const step2Config: QuestionDialogConfig = {
			title: "Add MCP Server (2/2) — stdio",
			pages: [
				{
					title: "Command",
					prompt: "Executable command:",
					mode: { type: "input", placeholder: "e.g. npx" },
				},
				{
					title: "Args",
					prompt: "Arguments (comma-separated, leave blank for none):",
					mode: {
						type: "input",
						placeholder: "e.g. -y, @modelcontextprotocol/server-github",
					},
				},
			],
		};

		const result2 = await ctx.ui.question(step2Config);
		if (!result2.completed) return;

		const commandAnswer: QuestionAnswer | null = result2.answers[0] ?? null;
		const argsAnswer: QuestionAnswer | null = result2.answers[1] ?? null;

		if (!commandAnswer || commandAnswer.type !== "input") return;

		const command = commandAnswer.value.trim();
		if (!command) {
			ctx.ui.notify("Command cannot be empty", "error");
			return;
		}

		const argsRaw = argsAnswer?.type === "input" ? argsAnswer.value.trim() : "";
		const args = argsRaw
			? argsRaw
					.split(",")
					.map((s) => s.trim())
					.filter((s) => s.length > 0)
			: [];

		const newServer: McpServerConfig = { name, transport: "stdio", command, args };
		const newConfig: McpConfig = {
			...config,
			servers: { ...config.servers, [name]: newServer },
		};

		await deps.saveAndReload(ctx, newConfig, "local");
		ctx.ui.notify(`Server "${name}" added (stdio: ${command})`, "info");
	} else {
		// http
		const step2Config: QuestionDialogConfig = {
			title: "Add MCP Server (2/2) — http",
			pages: [
				{
					title: "URL",
					prompt: "Server URL:",
					mode: {
						type: "input",
						placeholder: "e.g. https://mcp.example.com/sse",
					},
				},
			],
		};

		const result2 = await ctx.ui.question(step2Config);
		if (!result2.completed) return;

		const urlAnswer: QuestionAnswer | null = result2.answers[0] ?? null;
		if (!urlAnswer || urlAnswer.type !== "input") return;

		const url = urlAnswer.value.trim();
		if (!url) {
			ctx.ui.notify("URL cannot be empty", "error");
			return;
		}

		const newServer: McpServerConfig = { name, transport: "http", url };
		const newConfig: McpConfig = {
			...config,
			servers: { ...config.servers, [name]: newServer },
		};

		await deps.saveAndReload(ctx, newConfig, "local");
		ctx.ui.notify(`Server "${name}" added (http: ${url})`, "info");
	}
}
