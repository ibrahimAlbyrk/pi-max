# Subagent Detail View UI Regression

**Date**: 2026-03-04
**Status**: Diagnosed, fix pending
**Affected**: `.pi/extensions/subagent-system/`, `packages/coding-agent/src/modes/interactive/interactive-mode.ts`

## Problem

When drilling into a subagent's detail view (feed panel), the input bar, footer separator, and agent list/tab bar at the bottom are no longer visible. Only the header and chat content area render. This regressed after the region-based layout refactor.

## Root Cause

The feed panel is a full-screen custom component rendered via `ctx.ui.custom()` **without** `overlay: true`. In the current region-based layout system, non-overlay custom components are added to `editorContainer`, which lives inside the **fixed-height "input" region**.

### Layout Architecture (post-refactor)

```
┌─────────────────────────────┐
│  "chat" region (flex)       │  ← scrollable, takes remaining space
│  contains: chatContainer    │
├─────────────────────────────┤
│  "input" region (fixed)     │  ← height = sum of component content
│  contains: editorContainer  │  ← custom components go HERE
└─────────────────────────────┘
```

### What Happens

1. `agent-channel.ts:showChannel()` calls `ctx.ui.custom(factory)` — no overlay flag
2. `interactive-mode.ts:showExtensionCustom()` (line ~1860) adds component to `editorContainer`
3. `editorContainer` is in the fixed "input" region (~6-10 lines tall)
4. Feed panel renders for full terminal height (`termHeight` lines):
   - Header (2 lines)
   - Content area (`termHeight - 6` lines)
   - Input separator (1 line)
   - Input bar (1 line)
   - Footer separator (1 line)
   - Agent list/tab bar (1+ lines)
5. LayoutEngine clips content to the input region height
6. Bottom elements (input bar, footer, agent list) are **cut off**

### Before (linear layout)

Custom components added via `ui.addChild()` occupied the full terminal. All elements visible.

### After (region-based layout, commit 8b8f2bcd)

Custom components constrained to input region. Bottom ~4 lines lost.

## Key Files

| File | Lines | Role |
|------|-------|------|
| `interactive-mode.ts` | 390-407 | Region setup (chat=flex, input=fixed) |
| `interactive-mode.ts` | 1847-1865 | `showExtensionCustom()` — adds to editorContainer |
| `agent-channel.ts` | ~679, ~777 | `ctx.ui.custom()` call without overlay |
| `agent-channel.ts` | 756-890 | `renderFeedView()` — expects full terminal height |
| `tui.ts` | ~1323-1324 | `doRegionRender()` enforces viewport height |
| `layout.ts` | 78-92 | LayoutEngine fixed region height calculation |

## Fix Options

### Option A: Use Overlay Mode (Recommended)

Modify `agent-channel.ts` to show the feed panel as a full-screen overlay:

```typescript
const result = await ctx.ui.custom<string | null>(factory, {
  overlay: true,
  overlayOptions: {
    anchor: "top-left",
    percentWidth: "100%",
    percentHeight: "100%",
  },
});
```

**Pros**: Minimal change, reuses existing overlay system, no layout impact
**Cons**: May need overlay z-ordering adjustments

### Option B: Temporarily Disable Regions

In `showExtensionCustom()`, detect non-overlay full-screen components and temporarily remove regions, restoring them after close.

**Pros**: Preserves non-overlay rendering path
**Cons**: More invasive, risk of region state bugs

### Option C: Full-Screen Region

Add a temporary full-screen region that replaces chat+input when showing full-screen custom components.

**Pros**: Clean architectural fit
**Cons**: Most complex, requires LayoutEngine changes

## Recommendation

**Option A** — use overlay mode. The feed panel already supports full-screen rendering. Overlay mode bypasses the region constraint entirely with minimal code change.
