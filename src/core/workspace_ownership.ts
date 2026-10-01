import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { resolve, sep } from "node:path";
import { SpawnGitRunner, STATUS_PROBE, parsePorcelainPaths } from "./git_commit_guard.js";

/** Conservative whole-path ownership. A mixed user/model file is never staged
 * automatically. This is attribution between serialized local operations,
 * not a filesystem lock against unrelated programs writing concurrently.
 */
export class WorkspaceOwnership {
  private readonly runner: SpawnGitRunner;
  private readonly repoRoot: string;
  private last = new Map<string, string>();
  private readonly excluded = new Set<string>();
  private readonly owned = new Set<string>();
  private usable = true;

  constructor(private readonly root: string) {
    this.runner = new SpawnGitRunner(root);
    const repo = this.runner.run(["rev-parse", "--show-toplevel"]);
    this.repoRoot = repo.ok ? repo.stdout.trim() : root;
    this.last = this.capture();
    for (const path of this.last.keys()) this.excluded.add(path);
  }

  private capture(): Map<string, string> {
    const status = this.runner.run([...STATUS_PROBE]);
    const result = new Map<string, string>();
    if (!status.ok) { this.usable = false; return result; }
    for (const path of parsePorcelainPaths(status.stdout)) {
      const abs = resolve(this.repoRoot, path);
      if (abs !== this.root && !abs.startsWith(this.root + sep)) { this.usable = false; continue; }
      try {
        const stat = lstatSync(abs);
        let value: string;
        if (stat.isSymbolicLink()) value = "link:" + readlinkSync(abs);
        else if (stat.isFile()) {
          const physical = realpathSync(abs);
          if (!physical.startsWith(this.root + sep)) { this.usable = false; continue; }
          value = createHash("sha256").update(readFileSync(abs)).digest("hex");
        } else { this.usable = false; continue; }
        result.set(path, `${stat.mode}:${value}`);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") result.set(path, "deleted");
        else this.usable = false;
      }
    }
    return result;
  }

  private changed(before: Map<string, string>, after: Map<string, string>): string[] {
    return [...new Set([...before.keys(), ...after.keys()])].filter(path => before.get(path) !== after.get(path));
  }

  /** Capture drift BEFORE every local mutation, including automatic commit. */
  before(): Map<string, string> {
    const now = this.capture();
    for (const path of this.changed(this.last, now)) {
      this.excluded.add(path);
      this.owned.delete(path);
    }
    this.last = now;
    return now;
  }

  after(before: Map<string, string>, origin: "user" | "model"): void {
    const now = this.capture();
    for (const path of this.changed(before, now)) {
      if (origin === "user") { this.excluded.add(path); this.owned.delete(path); }
      else if (!this.excluded.has(path)) this.owned.add(path);
    }
    this.last = now;
  }

  candidates(): ReadonlySet<string> {
    return this.usable ? this.owned : new Set();
  }
}
