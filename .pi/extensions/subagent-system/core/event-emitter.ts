/**
 * SubAgent System — Typed Event Emitter
 *
 * Simple event emitter with typed event support.
 * Used by AgentHandle implementations and AgentManager.
 */

export type EventHandler = (...args: any[]) => void | Promise<void>;

export class TypedEventEmitter {
  private listeners = new Map<string, Set<EventHandler>>();

  on(event: string, handler: EventHandler): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(handler);
  }

  off(event: string, handler: EventHandler): void {
    const handlers = this.listeners.get(event);
    if (handlers) {
      handlers.delete(handler);
      if (handlers.size === 0) {
        this.listeners.delete(event);
      }
    }
  }

  emit(event: string, ...args: any[]): void {
    const handlers = this.listeners.get(event);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        const result = handler(...args);
        // If handler returns a promise, catch errors silently
        if (result && typeof result === "object" && "catch" in result) {
          (result as Promise<void>).catch((err) => {
            console.error(`[subagent] Event handler error for "${event}":`, err);
          });
        }
      } catch (err) {
        console.error(`[subagent] Event handler error for "${event}":`, err);
      }
    }
  }

  removeAllListeners(event?: string): void {
    if (event) {
      this.listeners.delete(event);
    } else {
      this.listeners.clear();
    }
  }

  listenerCount(event: string): number {
    return this.listeners.get(event)?.size ?? 0;
  }
}
