# TUI Mouse Text Selection — Architecture Spec

## Overview

Terminal mouse tracking (`?1000h`) captures all mouse events, preventing native text selection. Instead of fighting this, we build a first-class text selection system inside the TUI that handles left-click, drag, and copy — while keeping scroll wheel support.

**Goal**: Click to place cursor, drag to select text, auto-copy to clipboard. No extra keys needed.

---

## Architecture

### Core Components

```
┌─────────────────────────────────────────────────────┐
│                      TUI                            │
│                                                     │
│  stdin ──► StdinBuffer ──► handleInput()            │
│                               │                     │
│                    ┌──────────┴──────────┐          │
│                    │                     │          │
│              Mouse events          Key events       │
│                    │                     │          │
│              ┌─────▼─────┐               │          │
│              │ Selection  │               │          │
│              │  Manager   │               │          │
│              └─────┬─────┘               │          │
│                    │                     │          │
│              ┌─────▼─────────────────────▼───┐      │
│              │      Render Pipeline          │      │
│              │                               │      │
│              │  Components render lines       │      │
│              │         │                     │      │
│              │  SelectionRenderer applies    │      │
│              │  highlight to selected range  │      │
│              │         │                     │      │
│              │  Write to terminal            │      │
│              └───────────────────────────────┘      │
│                                                     │
│              ┌───────────┐                          │
│              │ Clipboard  │  (OSC 52 / pbcopy)      │
│              └───────────┘                          │
└─────────────────────────────────────────────────────┘
```

### 1. Mouse Protocol Change

**Current**: `?1000h` (normal tracking — press/release only)  
**New**: `?1002h` (button-event tracking — press/release/drag)

This gives us drag events (button 32 = left-drag) needed for selection, while still receiving scroll wheel (64/65) and click (0) events. No behavior change for existing functionality.

Files: `alternate-screen.ts`, `tui.ts` (focus recovery, idle re-enable)

### 2. SelectionManager (`selection-manager.ts`)

Single source of truth for selection state. Stateless rendering — no DOM, no retained nodes.

```typescript
interface ScreenPosition {
  row: number;      // 0-indexed screen row
  col: number;      // 0-indexed visible column
}

interface ContentPosition {
  regionId: string;
  lineIndex: number; // line index in rendered content (after scroll offset)
  charIndex: number; // visible character index (ANSI-stripped)
}

interface SelectionRange {
  anchor: ContentPosition;  // where click started
  head: ContentPosition;    // where drag currently is
}

class SelectionManager {
  private range: SelectionRange | null = null;
  private isDragging: boolean = false;
  private lastClickTime: number = 0;
  private lastClickPos: ScreenPosition | null = null;
  private clickCount: number = 0;

  // Mouse event handlers
  onMouseDown(pos: ScreenPosition): void;
  onMouseDrag(pos: ScreenPosition): void;
  onMouseUp(pos: ScreenPosition): void;

  // State queries
  getSelection(): SelectionRange | null;
  getSelectedText(regionLines: Map<string, string[]>): string;
  hasSelection(): boolean;
  clear(): void;

  // For render pipeline
  getSelectionForLine(regionId: string, lineIndex: number): 
    { startCol: number; endCol: number } | null;
}
```

**Selection direction**: Anchor is fixed (where press happened), head follows drag. Selection can go forward or backward — `getSelectionForLine()` normalizes to (start, end) for rendering.

**Click detection**:
- Single click: clear selection, start new anchor
- Double click (<300ms, same position ±2 cols): select word
- Triple click (<300ms after double): select entire line

### 3. Position Mapping (`position-mapper.ts`)

Maps screen coordinates to content positions. This is the critical bridge.

```typescript
class PositionMapper {
  // Called after layout calculation, before render write
  setRegionLayouts(layouts: RegionLayout[]): void;
  setScrollOffset(regionId: string, offset: number): void;

  // Core mapping
  screenToContent(screen: ScreenPosition): ContentPosition | null;

  // For text extraction
  getLineText(regionId: string, lineIndex: number): string; // ANSI-stripped
  getRenderedLine(regionId: string, lineIndex: number): string; // with ANSI
}
```

**Mapping algorithm**:
```
screenToContent(row, col):
  1. Find region where row ∈ [region.startRow, region.startRow + region.height)
  2. lineInViewport = row - region.startRow
  3. If scrollable: contentLine = lineInViewport + floor(scrollOffset)
     Else: contentLine = lineInViewport
  4. charIndex = visualColToCharIndex(renderedLine, col)
     → Walk rendered line, skip ANSI codes, count visible columns
     → Use existing extractAnsiCode() for ANSI skipping
     → Use grapheme segmenter for wide char / emoji awareness
  5. Return { regionId, lineIndex: contentLine, charIndex }
```

**Why a separate class**: Position mapping logic is non-trivial (ANSI skipping, wide chars, scroll offset). Isolating it makes it testable and keeps SelectionManager clean.

### 4. Selection Rendering

**Approach**: Post-process rendered lines before terminal write. No component changes needed.

```typescript
function applySelectionHighlight(
  line: string,           // rendered line with ANSI codes
  startCol: number,       // selection start (visible column), -1 if starts before
  endCol: number,         // selection end (visible column), -1 if extends beyond
  lineWidth: number       // total visible width of line
): string;
```

**Algorithm**:
```
applySelectionHighlight(line, startCol, endCol, lineWidth):
  actualStart = startCol === -1 ? 0 : startCol
  actualEnd = endCol === -1 ? lineWidth : endCol

  before = sliceByColumn(line, 0, actualStart)
  selected = sliceByColumn(line, actualStart, actualEnd - actualStart)
  after = sliceByColumn(line, actualEnd, lineWidth - actualEnd)

  // Apply highlight: reverse video (theme-compatible)
  return before + "\x1b[7m" + selected + "\x1b[27m" + restoreAnsiState + after
```

**Integration point**: In `doRegionRender()`, after `getVisibleSlice()` returns lines for a region, before writing to terminal buffer. For each line, check `SelectionManager.getSelectionForLine()` and apply highlight if selected.

**Why reverse video (`\x1b[7m`)**:
- Works with any color scheme (light/dark)
- No hardcoded colors that might clash with user's theme
- Clean, native terminal look — modern terminals render it beautifully
- Reset with `\x1b[27m` (reverse off) — surgical, doesn't reset other styles

### 5. Clipboard Integration (`clipboard.ts`)

```typescript
async function copyToClipboard(text: string): Promise<boolean>;
```

**Strategy** (try in order):
1. **OSC 52** — Universal, works over SSH, no subprocess needed
   ```
   \x1b]52;c;{base64(text)}\x07
   ```
2. **Platform fallback** — For terminals that don't support OSC 52
   - macOS: `pbcopy` via stdin pipe
   - Linux: `xclip -selection clipboard` or `xsel --clipboard`
   - WSL: `clip.exe`

**When to copy**: On mouse release, if selection exists. Silent — no visual confirmation needed beyond the highlight itself remaining briefly visible.

### 6. Auto-Scroll During Drag

When dragging past the top/bottom edge of a scrollable region:

```typescript
// In SelectionManager
private autoScrollTimer: NodeJS.Timeout | null = null;
private autoScrollSpeed: number = 0;

onMouseDrag(pos: ScreenPosition):
  region = findRegion(pos.row)
  if pos.row < region.startRow:
    startAutoScroll('up', distance = region.startRow - pos.row)
  elif pos.row >= region.startRow + region.height:
    startAutoScroll('down', distance = pos.row - region.startRow - region.height + 1)
  else:
    stopAutoScroll()
    updateSelection(pos)

startAutoScroll(direction, distance):
  speed = clamp(distance, 1, 5)  // faster when further from edge
  autoScrollTimer = setInterval(() =>
    scrollController.scroll(direction, speed * 0.5)
    updateSelection(lastMousePos)
    requestRender()
  , 50)  // 20fps scroll
```

---

## Visual Design

### Selection Highlight

```
┌─ Assistant ──────────────────────────────────┐
│ Here is the code you requested:              │
│                                              │
│ ```typescript                                │
│ function hello() {                           │
│   console.log(██████████████████);           │  ← selected (reversed)
│   return ████████                            │  ← selected (reversed)
│ }                                            │
│ ```                                          │
└──────────────────────────────────────────────┘
```

- **Reverse video** for selection: inherits user's fg/bg but swapped
- Selection is visible across any theme (dark, light, custom)
- No borders, no underlines, no extra decoration — just clean inversion
- Selection clears on: Escape, any keystroke, content change, new click elsewhere

### Interaction Feedback

| Action | Visual |
|--------|--------|
| Click | Selection clears, no visible change |
| Drag | Selection highlight follows cursor in real-time |
| Release | Selection persists, text copied to clipboard |
| Double-click | Word highlighted |
| Triple-click | Full line highlighted |
| Escape / typing | Selection clears |

---

## Optimization

### Performance Concerns

1. **Drag event frequency**: Terminals can send 60+ drag events/sec. Rate-limit render to 30fps max during drag — accumulate position, render on next frame.

2. **ANSI column mapping**: `visualColToCharIndex()` walks the string on every call. For drag (many calls per line), cache the column map per rendered line. Invalidate on re-render.

3. **Render scope**: During selection drag, only re-render the selection region — don't re-render all regions. The differential render in region mode already handles this partially (per-line diff), but we can optimize further by only recalculating highlight for changed lines.

4. **Large content**: Selection of very long content (thousands of lines) for clipboard — build text lazily on mouse-up, not during drag.

5. **sliceByColumn cost**: Already uses cached `visibleWidth()`. For selection, we call it 3x per highlighted line (before, selected, after). Pre-compute column boundaries once per line.

### Memory

- SelectionManager: ~100 bytes (anchor + head + flags)
- PositionMapper: Holds references to existing RegionLayout array (no copy)
- Column cache: ~1KB per visible line during drag (evicted on re-render)
- Clipboard text: Built on-demand at mouse-up, not retained

---

## Edge Cases

| Case | Behavior |
|------|----------|
| Click outside any region | Ignore |
| Drag across region boundary | Clamp to origin region |
| Selection on empty line | Select the empty line (newline for clipboard) |
| Wide chars (CJK/emoji) at selection boundary | Snap to whole grapheme (don't split) |
| Scroll during selection | Selection follows content (stays on same content lines) |
| Content changes during selection | Clear selection |
| Selection in non-scrollable region | Works the same (no scroll offset) |
| Overlay content at click position | Select underlying content (overlays are transient) |
| Tab characters in content | Already expanded to spaces by renderer |
| Mouse release outside terminal | Terminal sends release event when re-entering — handle gracefully |
| Very fast drag | Rate-limited rendering prevents frame drops |

---

## Implementation Plan

### Phase 1: Foundation
- [ ] `clipboard.ts` — OSC 52 + platform fallback
- [ ] `position-mapper.ts` — screen-to-content coordinate mapping
- [ ] `selection-manager.ts` — core state machine (click, drag, release)
- [ ] Switch `?1000h` → `?1002h` in alternate-screen.ts and tui.ts re-enable points
- [ ] Route mouse click/drag/release events to SelectionManager in tui.ts

### Phase 2: Rendering
- [ ] `selection-renderer.ts` — `applySelectionHighlight()` function
- [ ] Integrate into `doRegionRender()` pipeline
- [ ] Render rate-limiting during drag (30fps cap)

### Phase 3: UX Polish
- [ ] Double-click word selection
- [ ] Triple-click line selection  
- [ ] Auto-scroll during drag past region edges
- [ ] Clear selection on Escape / keystroke / content change
- [ ] Clipboard copy on mouse-up

### Phase 4: Testing
- [ ] Unit tests for PositionMapper (ANSI strings, wide chars, emoji)
- [ ] Unit tests for SelectionManager state machine
- [ ] Unit tests for selection rendering (highlight application)
- [ ] Integration test: full mouse event → clipboard flow

---

## File Structure

```
packages/tui/src/
├── selection/
│   ├── selection-manager.ts    # State machine + mouse event handling
│   ├── position-mapper.ts      # Screen ↔ content coordinate mapping  
│   ├── selection-renderer.ts   # Highlight application on rendered lines
│   └── clipboard.ts            # OSC 52 + platform clipboard write
├── tui.ts                      # Integration: mouse routing, render hook
├── alternate-screen.ts         # ?1000h → ?1002h change
└── ...
```
