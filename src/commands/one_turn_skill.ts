/** Parse only the command and skill reference. The task is immutable literal
 * text after one required separator, including its remaining whitespace. */
export type OneTurnSkillCommand =
  | { kind: "invoke"; reference: string; task: string; source: string }
  | { kind: "usage"; message: string };

export function parseOneTurnSkill(raw: string): OneTurnSkillCommand | null {
  const command = /^[ \t]*\/skill(?=\s|$)/.exec(raw);
  if (!command) return null;
  const rest = raw.slice(command[0].length);
  const leading = /^[\s]+/.exec(rest)?.[0] ?? "";
  const afterLeading = rest.slice(leading.length);
  const reference = /^[^\s]+/.exec(afterLeading)?.[0] ?? "";
  const afterReference = afterLeading.slice(reference.length);
  if (!reference || !/^\s/.test(afterReference)) {
    return { kind: "usage", message: "usage: /skill <qualified-id> <task>" };
  }
  const task = afterReference.slice(1);
  if (!task.trim()) return { kind: "usage", message: "usage: /skill <qualified-id> <task>" };
  return { kind: "invoke", reference, task, source: raw };
}
