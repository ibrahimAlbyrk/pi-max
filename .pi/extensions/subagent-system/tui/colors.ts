/**
 * SubAgent System — Color Palette & Assignment
 *
 * Soft, pastel-inspired palette designed for dark terminals.
 * Foregrounds are muted / desaturated.
 * Backgrounds are very subtle tints — just enough to distinguish agents.
 */

export interface AgentColorInfo {
  name: string;
  fg: string;  // Foreground hex (muted pastel)
  bg: string;  // Background hex (very subtle tint)
}

export const AGENT_COLOR_PALETTE: AgentColorInfo[] = [
  { name: "blue",    fg: "#7BA7CC", bg: "#141e28" },
  { name: "purple",  fg: "#B08FD8", bg: "#1a1525" },
  { name: "cyan",    fg: "#6EC5C5", bg: "#121f20" },
  { name: "orange",  fg: "#D4A56A", bg: "#1e1812" },
  { name: "green",   fg: "#7BBF8E", bg: "#131e16" },
  { name: "pink",    fg: "#CC8DA8", bg: "#1e1319" },
  { name: "teal",    fg: "#69B8AD", bg: "#121d1b" },
  { name: "red",     fg: "#CC8080", bg: "#1e1313" },
  { name: "yellow",  fg: "#C9B86A", bg: "#1b1a12" },
  { name: "indigo",  fg: "#8A8FD8", bg: "#15152a" },
];

let nextColorIndex = 0;

/**
 * Assign a color to an agent. If the agent config specifies a color name,
 * that is used. Otherwise, a color is assigned round-robin from the palette.
 */
export function assignColor(preferredColor?: string): AgentColorInfo {
  if (preferredColor) {
    const found = AGENT_COLOR_PALETTE.find((c) => c.name === preferredColor);
    if (found) return found;
  }
  const color = AGENT_COLOR_PALETTE[nextColorIndex % AGENT_COLOR_PALETTE.length];
  nextColorIndex++;
  return color;
}

export function resetColorIndex(): void {
  nextColorIndex = 0;
}

/**
 * Status icon for agent states.
 */
export function getStatusIcon(status: string): string {
  switch (status) {
    case "idle":      return "○";
    case "working":   return "◉";
    case "thinking":  return "◉";
    case "completed": return "●";
    case "error":     return "✗";
    case "aborted":   return "✗";
    default:          return "○";
  }
}

/**
 * Hex → ANSI true-color foreground.
 */
export function hexToAnsi(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[38;2;${r};${g};${b}m`;
}

/**
 * Hex → ANSI true-color background.
 */
export function hexToBgAnsi(hex: string): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `\x1b[48;2;${r};${g};${b}m`;
}

export const ANSI_RESET = "\x1b[0m";
export const ANSI_DIM = "\x1b[2m";
export const ANSI_ITALIC = "\x1b[3m";
export const ANSI_STRIKETHROUGH = "\x1b[9m";
export const ANSI_BOLD = "\x1b[1m";

/**
 * Soft reset: clears bold, dim, italic, underline, strikethrough, fg color
 * but PRESERVES background. Use inside Box content so bgFn isn't killed.
 */
export const ANSI_SOFTRESET = "\x1b[22m\x1b[23m\x1b[24m\x1b[29m\x1b[39m";
