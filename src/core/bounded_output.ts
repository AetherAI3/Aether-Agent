/** Bounded UTF-8 capture of decoded output, in observed pipe-event order.
 * Callers decode each pipe independently before appending. The fixed buffers
 * own their bytes: even a huge input cannot leave a retained backing buffer.
 */
export class BoundedOutput {
  private readonly head: Buffer;
  private readonly tail: Buffer;
  private headLength = 0;
  private tailLength = 0;
  private tailNext = 0;
  private totalBytes = 0;

  constructor(maxBytes = 8000) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 128) throw new RangeError("output budget must be at least 128 bytes");
    // Reserve space for the omission notice, including a safe-integer count.
    const capacity = maxBytes - 80;
    this.head = Buffer.alloc(Math.floor(capacity / 3));
    this.tail = Buffer.alloc(capacity - this.head.length);
  }

  /** Fixed allocation, independent of the number/size of incoming chunks. */
  get capacityBytes(): number { return this.head.length + this.tail.length; }
  get retainedBytes(): number { return this.headLength + this.tailLength; }
  get observedBytes(): number { return this.totalBytes; }
  get truncated(): boolean { return this.totalBytes > this.capacityBytes; }

  append(text: string): void {
    const bytes = Buffer.from(text, "utf8");
    this.totalBytes += bytes.length;
    let offset = 0;
    if (this.headLength < this.head.length) {
      const count = Math.min(bytes.length, this.head.length - this.headLength);
      bytes.copy(this.head, this.headLength, 0, count);
      this.headLength += count;
      offset = count;
    }
    const remaining = bytes.length - offset;
    if (remaining >= this.tail.length) {
      bytes.copy(this.tail, 0, bytes.length - this.tail.length);
      this.tailLength = this.tail.length;
      this.tailNext = 0;
    } else if (remaining > 0) {
      const first = Math.min(remaining, this.tail.length - this.tailNext);
      bytes.copy(this.tail, this.tailNext, offset, offset + first);
      bytes.copy(this.tail, 0, offset + first);
      this.tailNext = (this.tailNext + remaining) % this.tail.length;
      this.tailLength = Math.min(this.tail.length, this.tailLength + remaining);
    }
  }

  private parts(): { head: Buffer; tail: Buffer; omittedBytes: number } {
    const tail = this.tailLength < this.tail.length
      ? this.tail.subarray(0, this.tailLength)
      : Buffer.concat([this.tail.subarray(this.tailNext), this.tail.subarray(0, this.tailNext)]);
    const head = this.head.subarray(0, this.headLength);
    if (!this.truncated) return { head, tail, omittedBytes: 0 };

    // Never manufacture replacement characters at either elision boundary.
    // Appended text contains complete code points; only our cuts can split one.
    let headEnd = head.length;
    if (headEnd > 0) {
      let start = headEnd - 1;
      while (start > 0 && (head[start]! & 0xc0) === 0x80) start--;
      const lead = head[start]!;
      const width = lead < 0x80 ? 1 : lead < 0xe0 ? 2 : lead < 0xf0 ? 3 : 4;
      if (headEnd - start < width) headEnd = start;
    }
    let tailStart = 0;
    while (tailStart < tail.length && (tail[tailStart]! & 0xc0) === 0x80) tailStart++;
    return {
      head: head.subarray(0, headEnd), tail: tail.subarray(tailStart),
      omittedBytes: this.totalBytes - headEnd - (tail.length - tailStart),
    };
  }

  get omittedBytes(): number { return this.parts().omittedBytes; }

  snapshot(): { text: string; totalBytes: number; omittedBytes: number } {
    return { text: this.render(), totalBytes: this.observedBytes, omittedBytes: this.omittedBytes };
  }

  render(): string {
    const { head, tail, omittedBytes } = this.parts();
    if (!omittedBytes) return Buffer.concat([head, tail]).toString("utf8");
    return head.toString("utf8")
      + `\n…[${omittedBytes} UTF-8 bytes elided]…\n`
      + tail.toString("utf8");
  }
}
