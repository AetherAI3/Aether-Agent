// Short-lived input lease for a declined tool call. It uses its own InputBuffer
// and never touches the composer, prompt history, queue, or reviewed shell item.
import { StringDecoder } from "node:string_decoder";
import type { Readable, Writable } from "node:stream";
import { MAX_DENIAL_FEEDBACK_BYTES, boundedDenialFeedback } from "../core/tool_approval.js";
import { InputBuffer } from "./input_line.js";
import { renderInputView } from "./input_render.js";
import { decodeKey, splitKeys } from "./keys.js";

export interface ApprovalFeedbackIO {
  input?: Readable & { isRaw?: boolean; setRawMode?: (raw: boolean) => unknown };
  output?: Writable;
  signal?: AbortSignal;
}

function printable(fragment: string): string {
  return fragment.replace(/[\r\n\t]+/g, " ")
    .replace(/[\x00-\x1f\x7f-\x9f\u2028\u2029\p{Cf}]/gu, "");
}

/** Enter skips an empty note; Escape/Ctrl+C cancel the note, not the denial. */
export function promptDenialFeedback(io: ApprovalFeedbackIO = {}): Promise<string | null> {
  const input = io.input ?? process.stdin;
  const output = io.output ?? process.stderr;
  if (io.signal?.aborted) return Promise.resolve(null);
  const buffer = new InputBuffer();
  const decoder = new StringDecoder("utf8");
  const priorRaw = Boolean(input.isRaw);
  const wasPaused = input.isPaused();
  let changedRaw = false;
  if (!priorRaw && input.setRawMode) {
    try { input.setRawMode(true); }
    catch { return Promise.resolve(null); }
    changedRaw = true;
  }
  const label = `Declined. Optional instruction (${MAX_DENIAL_FEEDBACK_BYTES} bytes; Enter skips, Esc cancels): `;
  const paint = (): void => {
    const view = renderInputView(label, buffer.value, buffer.pos,
      (output as Writable & { columns?: number }).columns ?? 80);
    output.write(`\r\x1b[2K${view.text}\x1b[${view.cursorCol}G`);
  };
  paint();
  return new Promise<string | null>((resolve) => {
    let settled = false;
    let pasting = false;
    let paste = "";
    const finish = (value: string | null): void => {
      if (settled) return;
      settled = true;
      input.off("data", onData);
      io.signal?.removeEventListener("abort", onAbort);
      if (changedRaw) { try { input.setRawMode?.(false); } catch { /* terminal may have closed */ } }
      if (wasPaused) input.pause();
      output.write("\n");
      resolve(boundedDenialFeedback(value));
    };
    const onAbort = (): void => finish(null);
    const fit = (base: string, raw: string): string => {
      let accepted = "";
      for (const char of printable(raw)) {
        if (Buffer.byteLength(base + accepted + char, "utf8") > MAX_DENIAL_FEEDBACK_BYTES) break;
        accepted += char;
      }
      return accepted;
    };
    const insert = (raw: string): void => {
      const accepted = fit(buffer.value, raw);
      if (accepted) buffer.insert(accepted);
      paint();
    };
    const onData = (chunk: Buffer | string): void => {
      const sequences = splitKeys(typeof chunk === "string" ? chunk : decoder.write(chunk));
      const returnTail = (index: number): void => {
        const tail = sequences.slice(index + 1).join("");
        if (tail) setImmediate(() => input.emit("data", Buffer.from(tail, "utf8")));
      };
      for (const [index, seq] of sequences.entries()) {
        if (seq === "\x03") { finish(null); returnTail(index); return; }
        const key = decodeKey(seq);
        if (pasting) {
          if (key.kind === "paste-end") { pasting = false; insert(paste); paste = ""; }
          else paste += fit(buffer.value + paste, seq);
          continue;
        }
        switch (key.kind) {
          case "paste-start": pasting = true; paste = ""; break;
          case "char": insert(key.value); break;
          case "backspace": buffer.backspace(); paint(); break;
          case "delete": buffer.deleteForward(); paint(); break;
          case "left": buffer.left(); paint(); break;
          case "right": buffer.right(); paint(); break;
          case "home": buffer.home(); paint(); break;
          case "end": buffer.end(); paint(); break;
          case "undo": buffer.undo(); paint(); break;
          case "submit":
          case "newline": finish(buffer.value); returnTail(index); return;
          case "escape":
          case "interrupt":
          case "eof": finish(null); returnTail(index); return;
          default: break;
        }
      }
    };
    input.on("data", onData);
    io.signal?.addEventListener("abort", onAbort, { once: true });
    if (io.signal?.aborted) onAbort();
    if (!settled) input.resume();
  });
}
