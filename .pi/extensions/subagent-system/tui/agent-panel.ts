/**
 * SubAgent System — Agent Panel Widget (above editor)
 *
 * Shows each agent on one line with viewport-based overflow:
 *   ○/◉ scout                          (working, toggle animation)
 *   ⠋ planner …the overall structure   (thinking, braille spinner)
 *   ● reviewer                         (completed)
 *
 * When agents overflow terminal width:
 *   [◉ w1  ◉ w2  ◉ w3  ◉ w4  +5 more]     ← normal view
 *   [‹3  ◉ w4  ◉ w5  [◉ w6]  +4 more]     ← selector scrolled
 *
 * Working agents get:
 *   - A smooth left→right shine/glint sweeping across the name
 *   - A toggling ○/◉ icon animation
 * Thinking agents get:
 *   - A braille spinner animation (⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏)
 */

import type { AgentHandle, AgentStatus, AgentMessageInfo } from "../core/types.js";
import { visibleWidth, truncateToWidth } from "@mariozechner/pi-tui";
import {
  getStatusIcon,
  hexToAnsi,
  ANSI_RESET,
  ANSI_DIM,
  ANSI_ITALIC,
  ANSI_STRIKETHROUGH,
  AGENT_COLOR_PALETTE,
} from "./colors.js";

// ─── Animation Constants ──────────────────────────────────────────────

/** Full shine sweep cycle duration (ms) */
const SHINE_CYCLE_MS = 2000;

/** Width of the shine highlight in character units */
const SHINE_WIDTH = 8;

/** How much to boost towards white at the shine peak (0–1) */
const SHINE_INTENSITY = 0.55;

/** Working icon toggle frames: empty circle ↔ filled circle */
const WORKING_FRAMES = ["○", "◉"];

/** Working icon toggle cycle duration (ms) */
const WORKING_TOGGLE_MS = 800;

/** Thinking icon frames: grow then shrink */
const THINKING_FRAMES = ["∙", "∘", "○", "∘"];

/** Thinking frame duration (ms) */
const THINKING_FRAME_MS = 350;

/** Fade-out duration for completed agents (ms) */
const FADE_DURATION_MS = 2000;

/** Spacing between agents on the horizontal bar */
const AGENT_SEP = `   `;
const AGENT_SEP_WIDTH = 3;

/** Padding around each agent segment: "  content " = 2 left + 1 right */
const SEGMENT_PAD_LEFT = 2;
const SEGMENT_PAD_RIGHT = 1;
const SEGMENT_PAD_TOTAL = SEGMENT_PAD_LEFT + SEGMENT_PAD_RIGHT;

// ─── Result Type ──────────────────────────────────────────────────────

export interface PanelRenderResult {
  lines: string[];
  /** Total number of agents */
  totalCount: number;
  /** How many agents are visible in the viewport */
  visibleCount: number;
  /** Index range of visible agents [startIdx, endIdx) — exclusive end */
  visibleRange: [number, number];
  /** Sorted agent IDs in display order */
  sortedIds: string[];
}

// ─── Helpers ──────────────────────────────────────────────────────────

function statusPriority(s: AgentStatus): number {
  switch (s) {
    case "working": case "thinking": return 0;
    case "idle":      return 1;
    case "completed": return 2;
    case "error": case "aborted": return 3;
    default: return 4;
  }
}

// ─── Color Math ───────────────────────────────────────────────────────

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

/** Lerp a color towards white by factor t (0 = original, 1 = white) */
function lerpToWhite(c: RGB, t: number): RGB {
  return {
    r: c.r + (255 - c.r) * t,
    g: c.g + (255 - c.g) * t,
    b: c.b + (255 - c.b) * t,
  };
}

/** Scale color brightness by a factor */
function scaleBrightness(c: RGB, factor: number): RGB {
  return {
    r: Math.min(255, c.r * factor),
    g: Math.min(255, c.g * factor),
    b: Math.min(255, c.b * factor),
  };
}

/**
 * Get fade-out ANSI color for a completed agent.
 * Brightness decays from ~0.5 → 0 over FADE_DURATION_MS using ease-out curve.
 */
function getCompletedFadeColor(baseRgb: RGB, completedAt: number | null, now: number): string {
  if (!completedAt) return ANSI_DIM;
  const elapsed = now - completedAt;
  const progress = Math.min(1, Math.max(0, elapsed / FADE_DURATION_MS));
  // Linear fade — consistent speed, no invisible tail at the end
  // Start at 45% brightness, fade to 0
  const brightness = 0.45 * (1 - progress);
  const faded = scaleBrightness(baseRgb, brightness);
  return rgbToAnsi(faded);
}

/**
 * Smooth bell curve (Gaussian-like) centered at `center` with width `sigma`.
 * Returns 0–1.
 */
function bell(x: number, center: number, sigma: number): number {
  const d = (x - center) / sigma;
  return Math.exp(-0.5 * d * d);
}

/**
 * Smooth ease-in-out for the shine sweep position.
 * Makes it feel less mechanical — slower at edges, faster in middle.
 */
function easeInOutCubic(t: number): number {
  return t < 0.5
    ? 4 * t * t * t
    : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

// ─── Shine Rendering ──────────────────────────────────────────────────

/**
 * Render a string with a shine sweep effect.
 * Each character gets per-character coloring that sweeps left→right.
 */
function renderWithShine(
  text: string,
  baseColor: RGB,
  now: number,
  agentOffset: number = 0,
): string {
  const totalWidth = text.length + SHINE_WIDTH * 2;
  // Each agent gets a slight time offset so they don't all shine in sync
  const phase = ((now + agentOffset * 400) % SHINE_CYCLE_MS) / SHINE_CYCLE_MS;
  const easedPhase = easeInOutCubic(phase);
  const shineCenter = -SHINE_WIDTH + easedPhase * totalWidth;

  let result = "";
  for (let i = 0; i < text.length; i++) {
    const shineFactor = bell(i, shineCenter, SHINE_WIDTH / 2.5) * SHINE_INTENSITY;
    const charColor = lerpToWhite(baseColor, shineFactor);
    result += rgbToAnsi(charColor) + text[i];
  }
  result += ANSI_RESET;
  return result;
}

/**
 * Get the pulsing icon for a working agent.
 * The ◉ icon smoothly pulses between dim and bright.
 */
function renderWorkingIcon(baseColor: RGB, now: number, agentOffset: number = 0): string {
  const elapsed = (now + agentOffset * 200) % WORKING_TOGGLE_MS;
  const frameIdx = elapsed < WORKING_TOGGLE_MS / 2 ? 0 : 1;
  return rgbToAnsi(baseColor) + WORKING_FRAMES[frameIdx] + ANSI_RESET;
}

function renderThinkingIcon(baseColor: RGB, now: number, agentOffset: number = 0): string {
  const elapsed = (now + agentOffset * 200) % (THINKING_FRAMES.length * THINKING_FRAME_MS);
  const frameIdx = Math.floor(elapsed / THINKING_FRAME_MS);
  return rgbToAnsi(baseColor) + THINKING_FRAMES[frameIdx] + ANSI_RESET;
}

// ─── Agent Segment Builder ───────────────────────────────────────────

interface AgentSegment {
  content: string;        // ANSI-styled content (icon + name + hint)
  plainWidth: number;     // visible width of content alone (no padding)
  totalWidth: number;     // plainWidth + padding (SEGMENT_PAD_TOTAL)
  selected: boolean;
  fgHex: string;
  col: string;
  agentId: string;
}

function buildSegments(sorted: AgentHandle[], now: number, selectedAgentId?: string): AgentSegment[] {
  const segments: AgentSegment[] = [];

  for (let idx = 0; idx < sorted.length; idx++) {
    const agent = sorted[idx];
    const colorInfo = AGENT_COLOR_PALETTE.find((c) => c.name === agent.color);
    const fgHex = colorInfo?.fg || "#7BA7CC";
    const col = hexToAnsi(fgHex);
    const baseRgb = hexToRgb(fgHex);

    const isActive = agent.status === "working" || agent.status === "thinking";
    const isSelected = selectedAgentId === agent.id;

    // ── Icon ──
    let icon: string;
    if (agent.status === "working") {
      icon = renderWorkingIcon(baseRgb, now, idx);
    } else if (agent.status === "thinking") {
      icon = renderThinkingIcon(baseRgb, now, idx);
    } else if (agent.status === "error" || agent.status === "aborted") {
      icon = `\x1b[38;2;204;128;128m${getStatusIcon(agent.status)}${ANSI_RESET}`;
    } else if (agent.status === "completed") {
      const fadeColor = getCompletedFadeColor(baseRgb, agent.completedAt, now);
      icon = `${fadeColor}${getStatusIcon(agent.status)}${ANSI_RESET}`;
    } else {
      icon = `${col}${getStatusIcon(agent.status)}${ANSI_RESET}`;
    }

    // ── Name ──
    let name: string;
    if (agent.status === "completed") {
      const fadeColor = getCompletedFadeColor(baseRgb, agent.completedAt, now);
      name = `${fadeColor}${ANSI_STRIKETHROUGH}${agent.name}${ANSI_RESET}`;
    } else if (agent.status === "error" || agent.status === "aborted") {
      name = `${ANSI_DIM}${agent.name}${ANSI_RESET}`;
    } else if (isActive) {
      name = renderWithShine(agent.name, baseRgb, now, idx);
    } else {
      name = `${col}${agent.name}${ANSI_RESET}`;
    }

    // ── Base content (icon + name) — used for stable width calculation ──
    const baseContent = `${icon} ${name}`;
    const baseWidth = visibleWidth(baseContent);

    const content = baseContent;

    segments.push({
      content,
      plainWidth: baseWidth,                      // stable — hint excluded
      totalWidth: baseWidth + SEGMENT_PAD_TOTAL,  // stable — hint excluded
      selected: isSelected,
      fgHex,
      col,
      agentId: agent.id,
    });
  }

  return segments;
}

// ─── Viewport Calculation ─────────────────────────────────────────────

/**
 * Calculate how many agents fit in the viewport starting from viewportStart.
 * Accounts for prefix indicator (‹N) and suffix indicator (+N more).
 */
function calculateVisibleRange(
  segments: AgentSegment[],
  width: number,
  viewportStart: number,
): { start: number; end: number } {
  const total = segments.length;
  if (total === 0) return { start: 0, end: 0 };

  // Clamp viewportStart
  const start = Math.max(0, Math.min(viewportStart, total - 1));

  // Reserve space for prefix "‹N " indicator if not at beginning
  const prefixReserve = start > 0 ? `‹${start} `.length + 1 : 0;

  let usedWidth = prefixReserve;
  let end = start;

  for (let i = start; i < total; i++) {
    const segWidth = segments[i].totalWidth;
    const sepWidth = (i > start) ? AGENT_SEP_WIDTH : 0;

    // How many agents remain after this one?
    const remaining = total - (i + 1);
    // Reserve space for "+N more" suffix if there will be remaining agents
    // We tentatively check: if we include this agent, will there be remaining ones?
    const suffixReserve = remaining > 0 ? ` +${remaining} more`.length + 1 : 0;

    const neededWidth = usedWidth + sepWidth + segWidth + suffixReserve;

    if (neededWidth > width) {
      // This agent doesn't fit. But we need at least 1 visible agent.
      if (i === start) {
        end = start + 1; // force at least 1
      }
      break;
    }

    usedWidth += sepWidth + segWidth;
    end = i + 1;
  }

  // Edge case: if nothing fit, show at least 1
  if (end <= start) end = start + 1;

  return { start, end: Math.min(end, total) };
}

// ─── Main Renderer ────────────────────────────────────────────────────

/**
 * Render the agent panel bar with viewport-based overflow.
 *
 * @param agents - list of agent handles
 * @param width - terminal width (max characters per line)
 * @param viewportStart - index of first visible agent (0 = beginning)
 * @param selectedAgentId - if set, that agent gets a selection outline
 */
export function renderAgentPanel(
  agents: AgentHandle[],
  width: number,
  viewportStart: number = 0,
  selectedAgentId?: string,
): PanelRenderResult {
  const emptyResult: PanelRenderResult = {
    lines: [],
    totalCount: 0,
    visibleCount: 0,
    visibleRange: [0, 0],
    sortedIds: [],
  };

  if (agents.length === 0) return emptyResult;

  const now = Date.now();

  // Filter out completed agents at 80% fade progress (remove before fully invisible)
  const visible = agents.filter((a) => {
    if (a.status === "completed" && a.completedAt) {
      return (now - a.completedAt) < FADE_DURATION_MS * 0.8;
    }
    return true;
  });

  if (visible.length === 0) return emptyResult;

  // Sort: active first (working/thinking), then idle, then completed/error
  const sorted = [...visible].sort((a, b) => {
    const pd = statusPriority(a.status) - statusPriority(b.status);
    return pd !== 0 ? pd : a.startedAt - b.startedAt;
  });

  const sortedIds = sorted.map((a) => a.id);
  const segments = buildSegments(sorted, now, selectedAgentId);

  // ── Calculate visible range ──
  const { start, end } = calculateVisibleRange(segments, width, viewportStart);
  const visibleSegments = segments.slice(start, end);
  const hiddenBefore = start;
  const hiddenAfter = segments.length - end;
  const hasSelection = visibleSegments.some((s) => s.selected);

  // ── Build prefix/suffix indicators ──
  const prefixStr = hiddenBefore > 0
    ? `${ANSI_DIM} ‹${hiddenBefore} ${ANSI_RESET}`
    : "";
  const prefixWidth = hiddenBefore > 0 ? ` ‹${hiddenBefore} `.length : 0;

  const suffixStr = hiddenAfter > 0
    ? `${ANSI_DIM}  +${hiddenAfter} more ${ANSI_RESET}`
    : "";
  const suffixWidth = hiddenAfter > 0 ? `  +${hiddenAfter} more `.length : 0;

  if (!hasSelection) {
    // ── Simple single-line render (no selection) ──
    const parts: string[] = [];
    if (prefixStr) parts.push(prefixStr);

    for (let i = 0; i < visibleSegments.length; i++) {
      if (i > 0) parts.push(AGENT_SEP);
      parts.push(`${" ".repeat(SEGMENT_PAD_LEFT)}${visibleSegments[i].content}${" ".repeat(SEGMENT_PAD_RIGHT)}`);
    }

    if (suffixStr) parts.push(suffixStr);

    const line = parts.join("");
    // Safety: truncate to width
    const safeLine = truncateToWidth(line, width);

    return {
      lines: [safeLine],
      totalCount: segments.length,
      visibleCount: visibleSegments.length,
      visibleRange: [start, end],
      sortedIds,
    };
  }

  // ── Two-line render with selection highlight ──
  const topParts: string[] = [];
  const contentParts: string[] = [];

  // Add prefix space
  if (prefixWidth > 0) {
    topParts.push(" ".repeat(prefixWidth));
    contentParts.push(prefixStr);
  }

  for (let i = 0; i < visibleSegments.length; i++) {
    const seg = visibleSegments[i];
    const w = seg.plainWidth + SEGMENT_PAD_TOTAL;

    if (i > 0) {
      topParts.push(" ".repeat(AGENT_SEP_WIDTH));
      contentParts.push(AGENT_SEP);
    }

    if (seg.selected) {
      const baseRgb = hexToRgb(seg.fgHex);
      const lineW = Math.max(3, w - 4);
      const padL = Math.floor((w - lineW) / 2);
      const padR = w - lineW - padL;
      topParts.push(" ".repeat(padL) + renderShineLine(lineW, baseRgb, now) + " ".repeat(padR));
    } else {
      topParts.push(" ".repeat(w));
    }

    contentParts.push(`${" ".repeat(SEGMENT_PAD_LEFT)}${seg.content}${" ".repeat(SEGMENT_PAD_RIGHT)}`);
  }

  // Add suffix space
  if (suffixWidth > 0) {
    topParts.push(" ".repeat(suffixWidth));
    contentParts.push(suffixStr);
  }

  const topLine = truncateToWidth(topParts.join(""), width);
  const contentLine = truncateToWidth(contentParts.join(""), width);

  return {
    lines: [topLine, contentLine],
    totalCount: segments.length,
    visibleCount: visibleSegments.length,
    visibleRange: [start, end],
    sortedIds,
  };
}

/**
 * Thin line with shine sweep — same effect as agent name shine
 * but applied to ─ characters. Solid base color with a bright
 * highlight sweeping left→right.
 */
function renderShineLine(width: number, baseColor: RGB, now: number): string {
  const cycle = 2000;
  const phase = (now % cycle) / cycle;
  const easedPhase = easeInOutCubic(phase);
  const sweepWidth = 6;
  const totalTravel = width + sweepWidth * 2;
  const shineCenter = -sweepWidth + easedPhase * totalTravel;

  let result = "";
  for (let i = 0; i < width; i++) {
    const shineFactor = bell(i, shineCenter, sweepWidth / 2.5) * 0.6;
    const c = lerpToWhite(baseColor, shineFactor);
    result += `\x1b[38;2;${Math.round(c.r)};${Math.round(c.g)};${Math.round(c.b)}m─`;
  }
  return result + ANSI_RESET;
}

