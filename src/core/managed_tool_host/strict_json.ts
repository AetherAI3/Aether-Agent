// Strict JSON over the raw bytes of a portable frame (spec section 4).
//
// JSON.parse cannot enforce the frame's lexical rules: it drops duplicate
// members, rounds large integers, accepts -0, fractions and exponents, and
// decodes escaped controls and lone surrogates silently. This single pass
// refuses each of them, in document order, before any value exists: a UTF-8
// byte order mark, invalid UTF-8, more than 262 144 bytes, nesting deeper than
// 16, a duplicate member (compared after unescaping), any number other than 0
// or [1-9][0-9]* up to 2^53 - 1, and any control character or unpaired
// surrogate in a string, raw or escaped. Keys are strings and follow the same
// rules. The result is plain data; object keys such as __proto__ become own
// properties.

import { fail } from "./errors.js";
import { MAX_FRAME_BYTES, MAX_FRAME_DEPTH, MAX_SAFE } from "./vocabulary.js";

// A leading byte order mark is refused by its own guard in parseFrame, before
// decoding. The decoder would strip one, so that guard is the only rule that
// refuses it.
const DECODER = new TextDecoder("utf-8", { fatal: true });
const MAX_SAFE_DIGITS = String(MAX_SAFE);
const QUOTE = 0x22;
const BACKSLASH = 0x5c;
const UNICODE_ESCAPE = `${String.fromCharCode(BACKSLASH)}u`;
const WHITESPACE = new Set([0x20, 0x09, 0x0a, 0x0d]);
const NUMBER_RUN = /^[0-9A-Za-z.+-]$/;
const CANONICAL_INTEGER = /^(?:0|[1-9][0-9]*)$/;
const HEX4 = /^[0-9A-Fa-f]{4}$/;
const LITERALS: readonly (readonly [string, boolean | null])[] = [["true", true], ["false", false], ["null", null]];
/** Each two-character escape, by the character after the backslash, and the UTF-16 unit it decodes to. */
const SIMPLE_ESCAPES: ReadonlyMap<string, number> = new Map([
  [String.fromCharCode(QUOTE), QUOTE],
  [String.fromCharCode(BACKSLASH), BACKSLASH],
  ["/", 0x2f],
  ["b", 0x08],
  ["f", 0x0c],
  ["n", 0x0a],
  ["r", 0x0d],
  ["t", 0x09],
]);

const isControl = (unit: number): boolean => unit < 0x20 || (unit >= 0x7f && unit <= 0x9f);

class Lexer {
  private pos = 0;
  private readonly src: string;

  constructor(src: string) {
    this.src = src;
  }

  parse(): unknown {
    this.skipWhitespace();
    const value = this.value(0);
    this.skipWhitespace();
    if (this.pos !== this.src.length) fail("Frame is not valid JSON.");
    return value;
  }

  private skipWhitespace(): void {
    while (WHITESPACE.has(this.src.charCodeAt(this.pos))) this.pos += 1;
  }

  private value(depth: number): unknown {
    const unit = this.src.charCodeAt(this.pos);
    if (unit === 0x7b) return this.object(depth + 1);
    if (unit === 0x5b) return this.array(depth + 1);
    if (unit === QUOTE) return this.string();
    if (unit === 0x2d || (unit >= 0x30 && unit <= 0x39)) return this.number();
    for (const [word, literal] of LITERALS) {
      if (this.src.startsWith(word, this.pos)) {
        this.pos += word.length;
        return literal;
      }
    }
    fail("Frame is not valid JSON.");
  }

  private open(depth: number): void {
    if (depth > MAX_FRAME_DEPTH) fail("Frame nests deeper than 16 levels.");
    this.pos += 1;
    this.skipWhitespace();
  }

  /** After a member: true when `close` ends the container, false after a comma. */
  private next(close: number): boolean {
    this.skipWhitespace();
    const unit = this.src.charCodeAt(this.pos);
    this.pos += 1;
    if (unit === close) return true;
    if (unit !== 0x2c) fail("Frame is not valid JSON.");
    this.skipWhitespace();
    return false;
  }

  private object(depth: number): Record<string, unknown> {
    this.open(depth);
    const entries: [string, unknown][] = [];
    const seen = new Set<string>();
    if (this.src.charCodeAt(this.pos) === 0x7d) {
      this.pos += 1;
      return Object.fromEntries(entries);
    }
    for (;;) {
      if (this.src.charCodeAt(this.pos) !== QUOTE) fail("Frame is not valid JSON.");
      const key = this.string();
      if (seen.has(key)) fail("Frame contains a duplicate object member.");
      seen.add(key);
      this.skipWhitespace();
      if (this.src.charCodeAt(this.pos) !== 0x3a) fail("Frame is not valid JSON.");
      this.pos += 1;
      this.skipWhitespace();
      entries.push([key, this.value(depth)]);
      if (this.next(0x7d)) return Object.fromEntries(entries);
    }
  }

  private array(depth: number): unknown[] {
    this.open(depth);
    const values: unknown[] = [];
    if (this.src.charCodeAt(this.pos) === 0x5d) {
      this.pos += 1;
      return values;
    }
    for (;;) {
      values.push(this.value(depth));
      if (this.next(0x5d)) return values;
    }
  }

  private string(): string {
    this.pos += 1;
    let out = "";
    let start = this.pos;
    for (;;) {
      if (this.pos >= this.src.length) fail("Frame is not valid JSON.");
      const unit = this.src.charCodeAt(this.pos);
      if (unit === QUOTE) {
        out += this.src.slice(start, this.pos);
        this.pos += 1;
        return out;
      }
      if (isControl(unit)) fail("Frame contains a control character.");
      if (unit === BACKSLASH) {
        out += this.src.slice(start, this.pos) + this.escape();
        start = this.pos;
      } else {
        this.pos += 1;
      }
    }
  }

  private hex(at: number): number {
    const digits = this.src.slice(at, at + 4);
    return HEX4.test(digits) ? Number.parseInt(digits, 16) : -1;
  }

  /**
   * Decodes one escape to its UTF-16 unit first and then applies the string
   * rules to that unit. An escaped newline is therefore refused by the same
   * control rule whether it is spelled with a letter or with four hex digits,
   * and a surrogate that is not half of an escaped pair is refused however it
   * was written.
   */
  private escape(): string {
    const marker = this.src.charAt(this.pos + 1);
    this.pos += 2;
    const code = SIMPLE_ESCAPES.get(marker) ?? this.unicodeEscape(marker);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = this.src.startsWith(UNICODE_ESCAPE, this.pos) ? this.hex(this.pos + 2) : -1;
      if (low >= 0xdc00 && low <= 0xdfff) {
        this.pos += 6;
        return String.fromCharCode(code, low);
      }
    }
    if (code >= 0xd800 && code <= 0xdfff) fail("Frame contains an unpaired surrogate.");
    if (isControl(code)) fail("Frame contains a control character.");
    return String.fromCharCode(code);
  }

  /** The unit named by a four-hex-digit escape; the backslash and marker are already consumed. */
  private unicodeEscape(marker: string): number {
    if (marker !== "u") fail("Frame is not valid JSON.");
    const code = this.hex(this.pos);
    if (code < 0) fail("Frame is not valid JSON.");
    this.pos += 4;
    return code;
  }

  /** The whole run of number-like characters, so 1e2, -0 and 0x1F are refused as one token. */
  private number(): number {
    const start = this.pos;
    while (this.pos < this.src.length && NUMBER_RUN.test(this.src.charAt(this.pos))) this.pos += 1;
    const token = this.src.slice(start, this.pos);
    if (!CANONICAL_INTEGER.test(token)) fail("Frame contains a non-canonical number.");
    if (token.length > MAX_SAFE_DIGITS.length || (token.length === MAX_SAFE_DIGITS.length && token > MAX_SAFE_DIGITS)) {
      fail("Frame contains an integer above 2^53 - 1.");
    }
    return Number(token);
  }
}

export function parseFrame(bytes: Uint8Array): unknown {
  if (bytes.length > MAX_FRAME_BYTES) fail("Frame exceeds 262144 bytes.");
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("Frame starts with a byte order mark.");
  let text: string;
  try {
    text = DECODER.decode(bytes);
  } catch {
    fail("Frame is not valid UTF-8.");
  }
  return new Lexer(text).parse();
}
