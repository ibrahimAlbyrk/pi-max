/**
 * SubAgent System — Message Area Rendering
 *
 * Renderers:
 *   subagent-activity     — tool call block (one per turn per agent)
 *   subagent-result       — completion block (inline collapsed / box expanded)
 *   subagent-error        — failure line (always inline, never expands)
 *   subagent-notification — hook notification
 *
 * Inline format (error/abort/collapsed result):
 *   ● scout · ✓ completed ── output preview · 2 turns  ↑5.1k  $0.02
 *
 * Bordered box (expanded result):
 *   ╭─[ scout · ✓ completed ]─────────────╮
 *   │  full output content                 │
 *   ╰─────────────────────────────────────╯
 */

import * as os from "node:os";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { visibleWidth, truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui";
import type { AgentManager } from "../core/agent-manager.js";
import { AGENT_COLOR_PALETTE, ANSI_DIM, ANSI_BOLD, ANSI_RESET, ANSI_SOFTRESET } from "./colors.js";

/**
 * Soft reset for use INSIDE content lines — clears bold/dim/italic/fg
 * but PRESERVES background color so the box bg isn't killed.
 */
const R = ANSI_SOFTRESET;

// ─── Helpers ──────────────────────────────────────────────────────────

function shortenPath(p: string): string {
  const home = os.homedir();
  let s = p.startsWith(home) ? `~${p.slice(home.length)}` : p;
  if (s.length > 50) {
    const parts = s.split("/");
    if (parts.length > 3) s = "…/" + parts.slice(-2).join("/");
  }
  return s;
}

function formatToolLine(toolName: string, args: Record<string, unknown>): string {
  switch (toolName) {
    case "bash": {
      const cmd = (args.command as string) || "…";
      return `$ ${cmd}`;
    }
    case "read": {
      const p = shortenPath((args.file_path || args.path || "…") as string);
      const off = args.offset as number | undefined;
      const lim = args.limit as number | undefined;
      let t = `read ${p}`;
      if (off || lim) t += `:${off || 1}-${(off || 1) + (lim || 0) - 1}`;
      return t;
    }
    case "write":
      return `write ${shortenPath((args.file_path || args.path || "…") as string)}`;
    case "edit":
      return `edit ${shortenPath((args.file_path || args.path || "…") as string)}`;
    case "grep":
      return `grep /${args.pattern || ""}/ in ${shortenPath((args.path || ".") as string)}`;
    case "find":
      return `find ${args.pattern || "*"} in ${shortenPath((args.path || ".") as string)}`;
    case "ls":
      return `ls ${shortenPath((args.path || ".") as string)}`;
    default: {
      const a = JSON.stringify(args);
      return `${toolName} ${a}`;
    }
  }
}

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10000) return `${(n / 1000).toFixed(1)}k`;
  if (n < 1000000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1000000).toFixed(1)}M`;
}

function formatUsage(usage: any): string {
  const parts: string[] = [];
  if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
  if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
  if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
  if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
  return parts.join("  ");
}

// ─── Color helpers ────────────────────────────────────────────────────

function getColorInfo(colorName: string) {
  return AGENT_COLOR_PALETTE.find((c) => c.name === colorName) || AGENT_COLOR_PALETTE[0];
}

/** ANSI true-color fg */
function fgAnsi(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/** ANSI true-color bg */
function bgAnsi(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

/** Dimmed version of a hex color (65% brightness) */
function dimHex(hex: string): string {
  const r = Math.round(parseInt(hex.slice(1, 3), 16) * 0.65);
  const g = Math.round(parseInt(hex.slice(3, 5), 16) * 0.65);
  const b = Math.round(parseInt(hex.slice(5, 7), 16) * 0.65);
  return `#${r.toString(16).padStart(2, "0")}${g.toString(16).padStart(2, "0")}${b.toString(16).padStart(2, "0")}`;
}

// ─── Shine Effect (Color Math) ────────────────────────────────────────

interface RGB { r: number; g: number; b: number }

function hexToRgb(hex: string): RGB {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function rgbToAnsi(c: RGB): string {
  return `\x1b[38;2;${Math.round(c.r)};${Math.round(c.g)};${Math.round(c.b)}m`;
}

function lerpToWhite(c: RGB, t: number): RGB {
  return {
    r: c.r + (255 - c.r) * t,
    g: c.g + (255 - c.g) * t,
    b: c.b + (255 - c.b) * t,
  };
}

/** Flash duration (ms) — how long the flash-to-settle animation lasts */
const FLASH_DURATION_MS = 800;
/** Peak flash intensity — how white the flash gets (0–1) */
const FLASH_PEAK = 0.65;

// ─── Inline Agent Line ────────────────────────────────────────────────
//
// Minimal single-line format for completed/failed/aborted agents:
//   ● scout · ✓ completed ── output preview · 2 turns  ↑5.1k  $0.02
//   ● thinker · ✗ failed ── Aborted · 1 turn  ↑2.2k  ↓14  $0.0115
//

interface InlineAgentLineOptions {
  agentName: string;
  agentColor: string;
  statusIcon: string;
  statusText: string;
  statusColorHex?: string;
  contentPreview?: string;
  usageText?: string;
}

class InlineAgentLine {
  private opts: InlineAgentLineOptions;
  private createdAt: number;
  private settled = false;
  private settledLines?: string[];

  constructor(opts: InlineAgentLineOptions) {
    this.opts = opts;
    this.createdAt = Date.now();
  }

  render(width: number): string[] {
    // Once settled (flash finished), return cached final state
    if (this.settled && this.settledLines) return this.settledLines;

    const { agentName, agentColor, statusIcon, statusText, statusColorHex, contentPreview, usageText } = this.opts;
    const colorInfo = getColorInfo(agentColor);
    const baseRgb = hexToRgb(colorInfo.fg);
    const statusColorRgb = statusColorHex ? hexToRgb(statusColorHex) : hexToRgb(dimHex(colorInfo.fg));

    // Flash intensity: cubic ease-out decay from FLASH_PEAK → 0
    const elapsed = Date.now() - this.createdAt;
    let flash = 0;
    if (elapsed < FLASH_DURATION_MS) {
      const t = elapsed / FLASH_DURATION_MS; // 0 → 1
      flash = FLASH_PEAK * (1 - t) * (1 - t) * (1 - t); // cubic decay
    } else {
      this.settled = true; // animation done, cache from now on
    }

    // Truncate preview to fit width
    let preview = "";
    let usedWidth = 4 + agentName.length + 3 + statusIcon.length + 1 + statusText.length; // "  ● name · icon text"

    if (contentPreview && usedWidth + 6 < width) {
      const maxPreview = Math.max(10, width - usedWidth - 4 - (usageText ? usageText.length + 3 : 0));
      preview = contentPreview;
      if (preview.length > maxPreview) preview = preview.slice(0, maxPreview - 1) + "…";
      usedWidth += 4 + preview.length;
    }

    let usagePart = "";
    if (usageText && usedWidth + usageText.length + 3 < width) {
      usagePart = usageText;
    }

    // Render helper — applies flash boost to each character
    let result = "";
    const emitText = (text: string, base: RGB, dim = false) => {
      let color = flash > 0 ? lerpToWhite(base, flash) : base;
      if (dim) color = { r: color.r * 0.6, g: color.g * 0.6, b: color.b * 0.6 };
      result += rgbToAnsi(color) + text;
    };

    // Build the line
    emitText("  ", baseRgb, true);
    emitText("●", baseRgb);
    emitText(" ", baseRgb, true);
    result += ANSI_BOLD;
    emitText(agentName, baseRgb);
    result += "\x1b[22m";
    emitText(" · ", baseRgb, true);
    emitText(`${statusIcon} ${statusText}`, statusColorRgb);

    if (preview) {
      emitText(" ── ", baseRgb, true);
      emitText(preview, baseRgb, true);
    }
    if (usagePart) {
      emitText(" · ", baseRgb, true);
      emitText(usagePart, baseRgb, true);
    }

    result += ANSI_RESET;
    const lines = [result];

    if (this.settled) this.settledLines = lines; // cache final state
    return lines;
  }

  invalidate(): void {
    if (!this.settled) {
      // During flash animation, allow re-render
    }
  }
}

/** Extract a one-line preview from multi-line output */
function extractOutputPreview(output: string, maxLen = 60): string {
  const firstLine = output.split("\n").find((l: string) => l.trim()) || "";
  let preview = firstLine.replace(/^#+\s*/, "").trim(); // strip markdown headers
  if (preview.length > maxLen) preview = preview.slice(0, maxLen - 1) + "…";
  return preview;
}

// ─── Bordered Agent Box ───────────────────────────────────────────────
//
// A custom Component that draws a bordered box with a title on the top border.
//
//   ╭─[ agent-name · status ]──────────╮
//   │  content line 1                   │
//   │  content line 2                   │
//   ╰──────────────────────────────────╯
//

interface BorderedAgentBoxOptions {
  /** Agent display name */
  agentName: string;
  /** Agent color name from palette */
  agentColor: string;
  /** Status badge text (e.g. "✓ completed", "✗ failed", "working") */
  statusText: string;
  /** Status badge ANSI color (hex). If not set, uses dimmed agent fg */
  statusColorHex?: string;
  /** Content lines (may contain ANSI codes) */
  contentLines: string[];
  /** Inner horizontal padding (default: 1) */
  paddingX?: number;
  /** Inner vertical padding (default: 0) */
  paddingY?: number;
}

class BorderedAgentBox {
  private opts: BorderedAgentBoxOptions;
  private cachedWidth?: number;
  private cachedLines?: string[];

  constructor(opts: BorderedAgentBoxOptions) {
    this.opts = opts;
  }

  render(width: number): string[] {
    if (this.cachedLines && this.cachedWidth === width) {
      return this.cachedLines;
    }

    const { agentName, agentColor, statusText, statusColorHex, contentLines } = this.opts;
    const padX = this.opts.paddingX ?? 1;
    const padY = this.opts.paddingY ?? 0;

    const colorInfo = getColorInfo(agentColor);
    const borderFg = fgAnsi(colorInfo.fg);
    const bgColor = bgAnsi(colorInfo.bg);
    const nameFg = fgAnsi(colorInfo.fg);
    const statusFg = statusColorHex ? fgAnsi(statusColorHex) : fgAnsi(dimHex(colorInfo.fg));

    // ── Build badge: [ agent-name · ✓ completed ]
    const badgePlain = `[ ${agentName} · ${statusText} ]`;
    // Badge sits on the top border line (no bg), so ANSI_RESET is safe here.
    const badgeStyled =
      `${borderFg}[ ` +
      `${nameFg}${ANSI_BOLD}${agentName}${ANSI_RESET}${borderFg}` +
      ` · ` +
      `${statusFg}${statusText}${ANSI_RESET}${borderFg}` +
      ` ]`;
    const badgeVisWidth = visibleWidth(badgePlain);

    // ── Effective inner width
    const innerWidth = Math.max(width - 2 - padX * 2, 10); // subtract 2 for │ borders + padding

    // ── Wrap content lines to inner width
    const wrappedContent: string[] = [];
    for (const line of contentLines) {
      if (line === "") {
        wrappedContent.push("");
      } else {
        const wrapped = wrapTextWithAnsi(line, innerWidth);
        wrappedContent.push(...wrapped);
      }
    }

    const lines: string[] = [];
    const fullInner = width - 2; // space between │ and │

    // Border lines (top/bottom): no bg, only border fg color.
    // Content lines: bgColor covers the inner area between │ borders.
    // R (ANSI_SOFTRESET) preserves bg inside content lines.

    // ── Top border: ╭─[ agent · status ]──────╮  (no bg)
    const dashesAfterBadge = Math.max(0, width - 2 - badgeVisWidth - 1);
    const topLine =
      `${borderFg}╭─${badgeStyled}${"─".repeat(dashesAfterBadge)}╮${ANSI_RESET}`;
    lines.push(topLine);

    // ── Top spacing (1 line with bg)
    lines.push(`${borderFg}│${ANSI_RESET}${bgColor}${" ".repeat(fullInner)}${ANSI_RESET}${borderFg}│${ANSI_RESET}`);

    // ── Top padding
    for (let i = 0; i < padY; i++) {
      lines.push(`${borderFg}│${ANSI_RESET}${bgColor}${" ".repeat(fullInner)}${ANSI_RESET}${borderFg}│${ANSI_RESET}`);
    }

    // ── Content lines
    for (const cLine of wrappedContent) {
      const contentVis = visibleWidth(cLine);
      const rightPad = Math.max(0, fullInner - padX - contentVis - padX);
      const innerContent = " ".repeat(padX) + cLine + " ".repeat(rightPad + padX);
      const row =
        `${borderFg}│${ANSI_RESET}` +
        `${bgColor}${innerContent}${ANSI_RESET}` +
        `${borderFg}│${ANSI_RESET}`;
      lines.push(row);
    }

    // ── Bottom padding
    for (let i = 0; i < padY; i++) {
      lines.push(`${borderFg}│${ANSI_RESET}${bgColor}${" ".repeat(fullInner)}${ANSI_RESET}${borderFg}│${ANSI_RESET}`);
    }

    // ── Bottom spacing (1 line with bg)
    lines.push(`${borderFg}│${ANSI_RESET}${bgColor}${" ".repeat(fullInner)}${ANSI_RESET}${borderFg}│${ANSI_RESET}`);

    // ── Bottom border: ╰──────────────╯  (no bg)
    const bottomLine = `${borderFg}╰${"─".repeat(fullInner)}╯${ANSI_RESET}`;
    lines.push(bottomLine);

    this.cachedWidth = width;
    this.cachedLines = lines;
    return lines;
  }

  invalidate(): void {
    this.cachedWidth = undefined;
    this.cachedLines = undefined;
  }
}

// ─── Register All Renderers ───────────────────────────────────────────

export function registerMessageRenderers(pi: ExtensionAPI, _manager: AgentManager): void {

  // ━━━ subagent-activity ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.registerMessageRenderer("subagent-activity", (message, { expanded }, theme) => {
    const d = message.details as any;
    const agentName: string = d?.agentName || "agent";
    const agentColor: string = d?.agentColor || "blue";
    const items: any[] = d?.items || [];

    const colorInfo = getColorInfo(agentColor);
    const dimFgHex = dimHex(colorInfo.fg);

    const toolLines: string[] = [];
    for (const item of items) {
      if (item.type === "tool" && item.toolName) {
        const line = formatToolLine(item.toolName, item.args);
        toolLines.push(`${fgAnsi(dimFgHex)}→${R} ${ANSI_DIM}${line}${R}`);
      }
    }

    if (toolLines.length === 0) return null as any;

    let shown: string[];
    let skipped = 0;

    if (!expanded) {
      const maxLines = 5;
      shown = toolLines.slice(-maxLines);
      skipped = toolLines.length - shown.length;
    } else {
      shown = toolLines;
    }

    const contentLines: string[] = [];
    if (skipped > 0) contentLines.push(`${ANSI_DIM}… ${skipped} earlier${R}`);
    contentLines.push(...shown);

    return new BorderedAgentBox({
      agentName,
      agentColor,
      statusText: "working",
      contentLines,
      paddingX: 1,
      paddingY: 0,
    });
  });

  // ━━━ subagent-result ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //   collapsed (expanded=false): inline single line
  //   expanded  (expanded=true):  bordered box with full output
  pi.registerMessageRenderer("subagent-result", (message, { expanded }, theme) => {
    const d = message.details as any;
    const agentName = d?.agentName || "agent";
    const agentColor = d?.agentColor || d?.color || "green";
    const output = d?.output || message.content;
    const usage = d?.usage;
    const usageText = usage ? formatUsage(usage) : "";

    // Collapsed → inline single line
    if (!expanded) {
      const preview = extractOutputPreview(output);
      return new InlineAgentLine({
        agentName,
        agentColor,
        statusIcon: "✓",
        statusText: "completed",
        statusColorHex: "#7BBF8E",
        contentPreview: preview || undefined,
        usageText: usageText || undefined,
      });
    }

    // Expanded → bordered box with full output
    const contentLines: string[] = [];
    const outLines = output.split("\n");
    contentLines.push(...outLines);

    if (usageText) {
      contentLines.push(`${ANSI_DIM}${usageText}${R}`);
    }

    return new BorderedAgentBox({
      agentName,
      agentColor,
      statusText: "✓ completed",
      contentLines,
      paddingX: 1,
      paddingY: 0,
    });
  });

  // ━━━ subagent-error ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  //   Always inline single line — never expands
  pi.registerMessageRenderer("subagent-error", (message, _opts, theme) => {
    const d = message.details as any;
    const agentName = d?.agentName || "agent";
    const agentColor = d?.agentColor || "red";
    const error = d?.error || message.content;
    const errorColorHex = "#CC8080";
    const usageText = d?.usage ? formatUsage(d.usage) : "";

    // Clean up error text for inline display
    const errorPreview = error.replace(/\s+/g, " ").trim();

    return new InlineAgentLine({
      agentName,
      agentColor,
      statusIcon: "✗",
      statusText: "failed",
      statusColorHex: errorColorHex,
      contentPreview: errorPreview || undefined,
      usageText: usageText || undefined,
    });
  });

  // ━━━ subagent-notification ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  pi.registerMessageRenderer("subagent-notification", (message, _opts, theme) => {
    const d = message.details as any;
    const level = d?.level || "info";
    const agentColor = d?.agentColor || "blue";

    const colorMap: Record<string, string> = {
      error: "#CC8080",
      warning: "#D4A56A",
      info: "#7BBF8E",
    };
    const levelHex = colorMap[level] || colorMap.info;

    const contentLines = [
      `${fgAnsi(levelHex)}[${level.toUpperCase()}]${R} ${message.content}`,
    ];

    return new BorderedAgentBox({
      agentName: d?.agentName || "system",
      agentColor,
      statusText: level,
      statusColorHex: levelHex,
      contentLines,
      paddingX: 1,
      paddingY: 0,
    });
  });
}
