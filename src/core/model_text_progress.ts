import { sanitizeTerm } from "../ui/text.js";

/**
 * Detect a model that keeps emitting the same short passage. A repeated token
 * can be ordinary prose, so only a sustained, chunk-independent cycle stops
 * advancing the turn's meaningful-progress clock.
 */
export class ModelTextProgress {
  private tail = "";
  private static readonly TAIL_CHARS = 1_024;
  private static readonly MIN_REPEAT_CHARS = 512;
  private static readonly MAX_PERIOD_CHARS = 256;

  meaningful(raw: string): boolean {
    // Server error messages are capped at 200 characters by
    // sanitizeServerText. Model output needs its trailing content considered:
    // two long chunks may share that prefix but have different answers after
    // it. Retain only the fixed-size suffix after stripping terminal controls.
    const text = sanitizeTerm(raw);
    if (!text.trim()) return false;
    this.tail = (this.tail + text.slice(-ModelTextProgress.TAIL_CHARS)).slice(-ModelTextProgress.TAIL_CHARS);
    return !this.repeatingSuffix();
  }

  private repeatingSuffix(): boolean {
    for (let period = 1; period <= ModelTextProgress.MAX_PERIOD_CHARS; period += 1) {
      const length = Math.max(ModelTextProgress.MIN_REPEAT_CHARS, period * 3);
      if (this.tail.length < length) continue;
      let repeated = true;
      for (let i = this.tail.length - length + period; i < this.tail.length; i += 1) {
        if (this.tail[i] !== this.tail[i - period]) {
          repeated = false;
          break;
        }
      }
      if (repeated) return true;
    }
    return false;
  }
}
