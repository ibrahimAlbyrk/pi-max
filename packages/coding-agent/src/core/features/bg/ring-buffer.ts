/**
 * Circular buffer for bounded output capture.
 * Older lines are discarded once capacity is reached.
 */
export class RingBuffer {
	private buffer: string[];
	private head: number = 0;
	private count: number = 0;

	constructor(private capacity: number = 500) {
		this.buffer = new Array<string>(capacity).fill("");
	}

	/**
	 * Push text into the buffer, splitting on newlines.
	 * Empty strings produced by trailing newlines are skipped.
	 */
	push(text: string): void {
		const lines = text.split("\n");
		for (const line of lines) {
			// Skip the trailing empty string from a newline-terminated chunk
			if (line === "" && lines.length > 1) continue;
			this.buffer[this.head] = line;
			this.head = (this.head + 1) % this.capacity;
			if (this.count < this.capacity) this.count++;
		}
	}

	/**
	 * Return the last `n` lines. Defaults to all buffered lines.
	 * Handles wrap-around correctly.
	 */
	getLines(n?: number): string[] {
		const total = Math.min(n ?? this.count, this.count);
		const result: string[] = [];
		const start = (this.head - this.count + this.capacity) % this.capacity;
		const offset = this.count - total;
		for (let i = 0; i < total; i++) {
			result.push(this.buffer[(start + offset + i) % this.capacity]);
		}
		return result;
	}

	/** Number of lines currently buffered. */
	get size(): number {
		return this.count;
	}

	/** Reset the buffer without reallocating. */
	clear(): void {
		this.head = 0;
		this.count = 0;
	}
}
