/**
 * An async iterable that producers push into and one consumer drains.
 * close() ends iteration after the buffer empties.
 */
export class PushQueue<T> implements AsyncIterable<T> {
  private buffer: T[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;

  push(item: T): void {
    if (this.closed) {
      return;
    }
    this.buffer.push(item);
    this.waiter?.();
  }

  close(): void {
    this.closed = true;
    this.waiter?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    for (;;) {
      while (this.buffer.length > 0) {
        yield this.buffer.shift()!;
      }
      if (this.closed) {
        return;
      }
      await new Promise<void>((resolve) => {
        this.waiter = resolve;
      });
      this.waiter = null;
    }
  }
}
