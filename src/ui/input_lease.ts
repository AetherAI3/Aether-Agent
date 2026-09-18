/** Exclusive ownership for a nested wizard. Preserve the original terminal's
 * mode and listeners; setup keystrokes must never also reach the coding queue. */
export function leaseTerminalInput(input: NodeJS.ReadableStream & { isRaw?: boolean; setRawMode?: (raw: boolean) => unknown }): () => void {
  const raw = input.isRaw ?? false;
  const paused = input.isPaused();
  const events = ["data", "keypress"] as const;
  const listeners = events.map(event => [event, input.rawListeners(event)] as const);
  for (const event of events) input.removeAllListeners(event);
  let released = false;
  return () => {
    if (released) return; released = true;
    for (const [event, saved] of listeners) {
      for (const listener of saved) input.on(event, listener as (...args: unknown[]) => void);
    }
    input.setRawMode?.(raw);
    if (paused) input.pause(); else input.resume();
  };
}
