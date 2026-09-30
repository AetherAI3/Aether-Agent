import { sanitizeTerm, visibleWidth } from "../ui/text.js";

/**
 * A bounded record of recent output fragments. Individual words and short
 * repetitions remain progress; a sustained passage made entirely of text
 * already seen stops extending the idle deadline. Chunk boundaries do not
 * affect the result, and every character in a long frame is inspected.
 */
export class ModelTextProgress {
  private static readonly FRAGMENT_CHARS = 32;
  private static readonly MAX_FRAGMENTS = 16_384;
  private static readonly REPEAT_GRACE_CHARS = 512;

  private fragment = "";
  private readonly seen = new Set<string>();
  private readonly order: string[] = [];
  private nextEviction = 0;
  private repeatedChars = 0;

  meaningful(raw: string): boolean {
    const text = sanitizeTerm(raw);
    if (visibleWidth(text.trim()) === 0) return false;
    let sawNovel = false;
    for (let i = 0; i < text.length; i += 1) {
      this.fragment = (this.fragment + text[i]).slice(-ModelTextProgress.FRAGMENT_CHARS);
      if (this.fragment.length < ModelTextProgress.FRAGMENT_CHARS) {
        sawNovel = true;
        continue;
      }
      if (this.seen.has(this.fragment)) {
        this.repeatedChars += 1;
        continue;
      }
      sawNovel = true;
      this.repeatedChars = 0;
      this.seen.add(this.fragment);
      if (this.order.length < ModelTextProgress.MAX_FRAGMENTS) {
        this.order.push(this.fragment);
      } else {
        this.seen.delete(this.order[this.nextEviction]!);
        this.order[this.nextEviction] = this.fragment;
        this.nextEviction = (this.nextEviction + 1) % ModelTextProgress.MAX_FRAGMENTS;
      }
    }
    return sawNovel || this.repeatedChars < ModelTextProgress.REPEAT_GRACE_CHARS;
  }
}
