// src/ui/keys.ts — raw-stdin key decoding for the REPL, pickers, and viewers.
// Pure: a chunk tokenizer (splitKeys) + a sequence decoder (decodeKey). Lives in
// ui/ so pickers don't reach into commands/ (layering: commands -> ui, never back).

export type Key =
  | { kind: "char"; value: string } // a printable run — may be multi-char (batched typing / paste)
  | { kind: "submit" }
  | { kind: "newline" }
  | { kind: "undo" }
  | { kind: "yank" }
  | { kind: "history-search" }
  | { kind: "backspace" }
  | { kind: "interrupt" }
  | { kind: "eof" }
  | { kind: "left" }
  | { kind: "right" }
  | { kind: "word-left" }
  | { kind: "word-right" }
  | { kind: "home" }
  | { kind: "end" }
  | { kind: "tab" }
  | { kind: "clear-screen" }
  | { kind: "up" }
  | { kind: "down" }
  | { kind: "delete" }
  | { kind: "word-delete" }
  | { kind: "kill-end" }
  | { kind: "kill-start" }
  | { kind: "paste-start" }
  | { kind: "paste-end" }
  | { kind: "escape" }
  | { kind: "ignore" };

/**
 * Tokenize a raw stdin chunk into complete key sequences. Node delivers batched
 * keystrokes, SSH-latency bursts, and multi-byte UTF-8 graphemes as ONE chunk —
 * without this split they'd match nothing in decodeKey and be silently dropped.
 */
export function splitKeys(chunk: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    const ch = chunk[i]!;
    if (ch === "\x1b") {
      const rest = chunk.slice(i);
      // CSI with full param/intermediate classes (mouse reports use < and ;),
      // then SS3 (application cursor mode).
      const m = rest.match(/^\x1b\[[0-9;:<=>?]*[ -/]*[@-~]/) ?? rest.match(/^\x1bO./);
      if (m) {
        out.push(m[0]);
        i += m[0].length;
        continue;
      }
      // Alt/Meta chord: ESC immediately followed by any other byte in the same
      // chunk is one token (so Alt+Enter can never decode as a bare submit).
      if (rest.length >= 2) {
        out.push(rest.slice(0, 2));
        i += 2;
        continue;
      }
      out.push("\x1b");
      i++;
      continue;
    }
    if (ch < " " || ch === "\x7f") {
      out.push(ch);
      i++;
      continue;
    }
    let j = i;
    while (j < chunk.length && chunk[j]! >= " " && chunk[j] !== "\x7f" && chunk[j] !== "\x1b") j++;
    out.push(chunk.slice(i, j));
    i = j;
  }
  return out;
}

/** Decode one key sequence (a splitKeys token) into a Key. Pure. */
export function decodeKey(seq: string, lfSubmits = false): Key {
  switch (seq) {
    case "\r":
      return { kind: "submit" };
    case "\n":
      return { kind: lfSubmits ? "submit" : "newline" };
    case "\x1f":
      return { kind: "undo" }; // ctrl-_
    case "\x19":
      return { kind: "yank" }; // ctrl-y
    case "\x12":
      return { kind: "history-search" }; // ctrl-r
    case "\x7f":
    case "\b":
      return { kind: "backspace" };
    case "\x03":
      return { kind: "interrupt" };
    case "\x04":
      return { kind: "eof" };
    case "\x01":
      return { kind: "home" }; // ctrl-a
    case "\x05":
      return { kind: "end" }; // ctrl-e
    case "\x0b":
      return { kind: "kill-end" }; // ctrl-k
    case "\x15":
      return { kind: "kill-start" }; // ctrl-u
    case "\x17":
      return { kind: "word-delete" }; // ctrl-w
    case "\t":
      return { kind: "tab" };
    case "\x0c":
      return { kind: "clear-screen" }; // ctrl-l
    case "\x1b\x7f":
    case "\x1b\b":
      return { kind: "word-delete" }; // alt-backspace
    case "\x1b[1;5D":
    case "\x1b[1;3D":
    case "\x1bb":
      return { kind: "word-left" }; // ctrl/alt-left, alt-b
    case "\x1b[1;5C":
    case "\x1b[1;3C":
    case "\x1bf":
      return { kind: "word-right" }; // ctrl/alt-right, alt-f
    case "\x1b[D":
      return { kind: "left" };
    case "\x1b[C":
      return { kind: "right" };
    case "\x1b[H":
    case "\x1b[1~":
      return { kind: "home" };
    case "\x1b[F":
    case "\x1b[4~":
      return { kind: "end" };
    case "\x1b[A":
    case "\x1bOA":
      return { kind: "up" };
    case "\x1b[B":
    case "\x1bOB":
      return { kind: "down" };
    case "\x1bOC":
      return { kind: "right" };
    case "\x1bOD":
      return { kind: "left" };
    case "\x1bOH":
      return { kind: "home" };
    case "\x1bOF":
      return { kind: "end" };
    case "\x1b[3~":
      return { kind: "delete" };
    case "\x1b":
      return { kind: "escape" };
    case "\x1b[200~":
      return { kind: "paste-start" };
    case "\x1b[201~":
      return { kind: "paste-end" };
    default:
      // A printable run (single char or a batched/multibyte text run).
      if (seq.length >= 1 && !seq.startsWith("\x1b") && seq >= " ") return { kind: "char", value: seq };
      return { kind: "ignore" };
  }
}
