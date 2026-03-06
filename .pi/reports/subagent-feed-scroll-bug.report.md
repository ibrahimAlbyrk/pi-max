# Bug Report: Mouse Scroll Broken After Closing Subagent Feed Panel

## Symptom
After closing the subagent detail/feed panel (Shift+Down or Escape), mouse wheel scrolling stops working on the main page. Instead of scrolling the chat, mouse wheel navigates through input history (up/down behavior). Switching to another terminal tab and back fixes the issue.

## Root Cause

**`.pi/extensions/subagent-system/tui/agent-channel.ts`, line 613:**

```typescript
// Disable mouse tracking when feed panel closes
process.stdout.write("\x1b[?1000l\x1b[?1006l");
```

The feed panel explicitly **disables SGR mouse tracking** when it closes. This breaks the main TUI's mouse handling because the main TUI depends on SGR mouse tracking being active to receive wheel events.

### Full Flow

1. **Main TUI enables SGR mouse tracking** on startup via `alternate-screen.ts:40`:
   ```
   \x1b[?1000h\x1b[?1006h
   ```
   With SGR tracking active, mouse wheel events arrive as `\x1b[<64;X;Y` (scroll up) and `\x1b[<65;X;Y` (scroll down), which the TUI routes to the chat scroll controller (`tui.ts:600-603`).

2. **Feed panel opens** (`agent-channel.ts:607`): redundantly re-enables mouse tracking (harmless):
   ```typescript
   process.stdout.write("\x1b[?1000h\x1b[?1006h");
   ```

3. **Feed panel closes** (`agent-channel.ts:613`): **disables** mouse tracking:
   ```typescript
   process.stdout.write("\x1b[?1000l\x1b[?1006l");
   ```

4. **`restoreEditor()` runs** (`interactive-mode.ts:1973-1990`): calls `this.ui.requestRender()` **without** `force = true`. This triggers a **differential render** in `doRegionRender()` which does NOT re-enable mouse tracking (only the full repaint path at line 1445 does).

5. **Result**: SGR mouse tracking is off. The terminal no longer sends SGR-encoded wheel events. Instead, some terminals convert wheel events to legacy escape sequences that the editor interprets as up/down arrow keys, causing input history navigation instead of page scroll.

### Why Switching Tabs Fixes It

When the user switches to another terminal/tab and comes back, the terminal sends a **focus-in event** (`\x1b[I`). The TUI handles this in `tui.ts:550-554`:

```typescript
if (data === "\x1b[I") {
    if (this.regionMode) {
        this.terminal.write("\x1b[?1000h\x1b[?1006h"); // Re-enables mouse tracking
    }
    this.requestRender(true);
    return;
}
```

This re-enables SGR mouse tracking, restoring normal scroll behavior.

## Fix

**Remove the mouse tracking disable line** from `agent-channel.ts:613`. The main TUI manages the SGR mouse tracking lifecycle — the extension should not interfere with it.

```diff
-    // Disable mouse tracking when feed panel closes
-    process.stdout.write("\x1b[?1000l\x1b[?1006l");
```

The enable line at `agent-channel.ts:607` is redundant but harmless (main TUI already has it enabled). It can optionally be removed for cleanliness:

```diff
-    // Enable SGR mouse tracking so wheel events reach handleInput
-    // instead of being handled by the terminal (which scrolls the buffer)
-    process.stdout.write("\x1b[?1000h\x1b[?1006h");
```

Alternatively, if there's concern about mouse tracking state being lost, the close line could **re-enable** instead of disable:

```diff
-    process.stdout.write("\x1b[?1000l\x1b[?1006l");
+    process.stdout.write("\x1b[?1000h\x1b[?1006h");
```

## Files Involved

| File | Line | Role |
|------|------|------|
| `.pi/extensions/subagent-system/tui/agent-channel.ts` | 613 | **Bug**: disables mouse tracking on feed close |
| `.pi/extensions/subagent-system/tui/agent-channel.ts` | 607 | Redundant enable on feed open |
| `packages/tui/src/alternate-screen.ts` | 40 | Initial mouse tracking enable |
| `packages/tui/src/tui.ts` | 550-554 | Focus-in re-enables tracking (workaround) |
| `packages/tui/src/tui.ts` | 1445 | Full repaint re-enables tracking |
| `packages/coding-agent/src/modes/interactive/interactive-mode.ts` | 1989 | `restoreEditor()` — non-force render, no mouse re-enable |
