/**
 * Keys seen lately, in two generations: on an add at least `periodMs` after
 * the last rotation, the older one is dropped. A key is remembered for at
 * least `periodMs` (about twice that while keys keep coming). A generation
 * that reaches `maxSize` rotates early: a memory guard for bursts, which
 * shortens the window.
 */
export class RecentKeys {
  private current = new Set<string>();
  private previous = new Set<string>();
  private rotatedAt: number;

  public constructor(
    private readonly periodMs: number,
    private readonly maxSize: number,
    now: number,
  ) {
    this.rotatedAt = now;
  }

  /** Records the key; true when it was not seen within the window. */
  public add(key: string, now: number): boolean {
    if (now - this.rotatedAt >= this.periodMs || this.current.size >= this.maxSize) {
      this.previous = this.current;
      this.current = new Set();
      this.rotatedAt = now;
    }
    if (this.current.has(key) || this.previous.has(key)) return false;
    this.current.add(key);
    return true;
  }

  public clear(now: number): void {
    this.current = new Set();
    this.previous = new Set();
    this.rotatedAt = now;
  }

  public get size(): number {
    return this.current.size + this.previous.size;
  }
}
