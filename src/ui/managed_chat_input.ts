import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";

type TerminalInput = NodeJS.ReadableStream & { isTTY?: boolean; isRaw?: boolean; setRawMode?: (raw: boolean) => unknown };

/** Give readline ordinary bytes and the mode controller back-tab, never both.
 * A real terminal may split an escape sequence at any byte boundary. */
export function managedChatInput(source: TerminalInput): { input: PassThrough & { isTTY: boolean }; keys: EventEmitter; dispose(): void } {
  const keys = new EventEmitter();
  const previousRaw = source.isRaw ?? false;
  const previousPaused = source.isPaused() || source.listenerCount("data") === 0;
  let pasting = false;
  const sequences = ["\x1b[Z", "\x1b[200~", "\x1b[201~"];
  const input = Object.assign(new PassThrough(), { isTTY: true, setRawMode: (raw: boolean) => { source.setRawMode?.(raw); } });
  let pending = Buffer.alloc(0);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const flush = (): void => { if (pending.length) input.write(pending); pending = Buffer.alloc(0); };
  const onData = (chunk: Buffer | string): void => {
    if (timer) clearTimeout(timer);
    const data = Buffer.concat([pending, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    pending = Buffer.alloc(0);
    let start = 0;
    for (let i = 0; i < data.length; i++) {
      if (data[i] !== 27) continue;
      const tail = data.subarray(i).toString("latin1");
      const sequence = sequences.find(value => tail.startsWith(value));
      if (sequence) {
        if (sequence === "\x1b[Z" && !pasting) {
          input.write(data.subarray(start, i));
          keys.emit("keypress", "", { name: "tab", shift: true });
          start = i + sequence.length;
        } else if (sequence === "\x1b[200~") pasting = true;
        else if (sequence === "\x1b[201~") pasting = false;
        i += sequence.length - 1;
      } else if (sequences.some(value => value.startsWith(tail))) {
        input.write(data.subarray(start, i)); pending = data.subarray(i); start = data.length; break;
      }
    }
    if (start < data.length) input.write(data.subarray(start));
    if (pending.length) { timer = setTimeout(flush, 100); timer.unref(); }
  };
  const onEnd = (): void => { if (timer) clearTimeout(timer); flush(); input.end(); };
  const onError = (error: Error): void => { input.destroy(error); };
  source.on("data", onData); source.on("end", onEnd); source.on("error", onError);
  let disposed = false;
  return { input, keys, dispose() {
    if (disposed) return; disposed = true;
    if (timer) clearTimeout(timer);
    source.removeListener("data", onData); source.removeListener("end", onEnd); source.removeListener("error", onError);
    input.destroy(); keys.removeAllListeners(); source.setRawMode?.(previousRaw);
    if (previousPaused) source.pause(); else source.resume();
  } };
}
