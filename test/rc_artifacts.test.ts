// #221 — generated-artifact metadata reaches an RC viewer from the media history.
//
// Four groups:
//
//   1. The commit seam     — only a committed history entry is ever observed
//   2. The projection      — identifier, type and safe label; nothing private
//   3. Delivery            — durable before network, replay shows one artifact
//   4. Production wiring   — the real media commands publish through the seam
//
// Every payload a stub broker receives here is checked against the Cloud
// display/1 contract (lib/remote_session/contracts.py). A payload that fails it
// is a 400, and a 400 keeps the batch: one bad artifact frame would wedge the
// whole outbox, so the stub refuses exactly what the Cloud refuses.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable, Writable } from "node:stream";
import { fileURLToPath } from "node:url";

import { photogenSlash } from "../src/commands/slash_media.js";
import { projectRefFor, rcOutboxPath } from "../src/commands/rc.js";
import { openRcCodingObserver } from "../src/commands/rc_observation.js";
import type { AppContext } from "../src/core/context.js";
import {
  historyPaths,
  loadHistory,
  MEDIA_HISTORY_SCHEMA_VERSION,
  type MediaEntry,
} from "../src/core/media_history.js";
import { appendEntry, type AppendInput } from "../src/core/media_history_store.js";
import { publicArtifactId, publishArtifactEntry } from "../src/core/rc/artifacts.js";
import { createOutbox, loadOutbox, saveOutbox } from "../src/core/rc/outbox.js";
import { artifactEvent } from "../src/core/rc/producers.js";
import { payloadDigest } from "../src/core/rc/receipts.js";
import type { ApiClient } from "../src/core/transport.js";

const NOW = "2026-10-05T12:00:00.000Z";
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");

// ── Cloud display/1 contract for `artifact` ────────────────────────────────

const FIXTURE = JSON.parse(readFileSync(join(REPO, "test", "fixtures", "rc-display-v1.json"), "utf8")) as {
  payload_keys: Record<string, string[]>;
};
const ARTIFACT_ALLOWED = new Set(FIXTURE.payload_keys["artifact"]);
const ARTIFACT_REQUIRED = ["artifact_id", "kind", "title"] as const;

/** Mirrors contracts.py `_validate_rc_display` for the artifact event type. */
function cloudArtifactViolation(payload: Record<string, unknown>): string | null {
  if (payload["projection_version"] !== "1") return "projection_version must be \"1\"";
  for (const key of ARTIFACT_REQUIRED) {
    if (!(key in payload)) return `missing required key ${key}`;
    if (typeof payload[key] !== "string" || payload[key] === "") return `${key} must be a non-empty string`;
  }
  for (const [key, value] of Object.entries(payload)) {
    if (!ARTIFACT_ALLOWED.has(key)) return `key ${key} is not allowed`;
    if (key === "projection_version") continue;
    if (typeof value !== "string" || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) {
      return `${key} must be a bounded single-line string`;
    }
  }
  return null;
}

function assertCloudAccepts(payload: Record<string, unknown>): void {
  assert.equal(cloudArtifactViolation(payload), null, JSON.stringify(payload));
}

// ── fixtures ────────────────────────────────────────────────────────────────

const PRIVATE_PATH_MARK = "private-user-dir";
const PROMPT = "a moody poster of the operator's secret launch codename";
const MODEL = "vision_nano_pro";
const SIGNED = "SIGNED-URL-CANARY";

function input(over: Partial<AppendInput> = {}): AppendInput {
  return {
    kind: "image",
    displayName: "hero.png",
    filePath: join(tmpdir(), PRIVATE_PATH_MARK, "aether-output", "hero.png"),
    url: `https://cdn.example/media/hero.png?X-Amz-Signature=${SIGNED}`,
    model: MODEL,
    prompt: PROMPT,
    sizeBytes: 2048,
    metadata: { privateNote: "metadata-canary" },
    ...over,
  };
}

function entry(over: Partial<MediaEntry> = {}): MediaEntry {
  return {
    artifactId: "0198f4c2-0000-8000-8000-000000000001",
    sequence: "7",
    createdAt: NOW,
    kind: "image",
    displayName: "hero.png",
    filePath: "/home/someone/aether-output/hero.png",
    url: `https://cdn.example/hero.png?sig=${SIGNED}`,
    model: MODEL,
    prompt: PROMPT,
    sizeBytes: 2048,
    source: "agent-media",
    ...over,
  };
}

const LEAKS = [PRIVATE_PATH_MARK, PROMPT, "secret launch", MODEL, "nano_pro", SIGNED, "cdn.example",
  "metadata-canary", "privateNote", "aether-output"];

function assertNoLeak(value: unknown): void {
  const text = JSON.stringify(value);
  for (const leak of LEAKS) assert.ok(!text.includes(leak), `${leak} leaked into ${text}`);
}

const SESSION = "rs_" + "a".repeat(32);

interface Sandbox {
  root: string;
  outboxPath: string;
  history: ReturnType<typeof historyPaths>;
  cleanup(): void;
}

function sandbox(session: string | null = SESSION): Sandbox {
  const root = resolve(mkdtempSync(join(tmpdir(), "aether-rc-artifacts-")));
  const outboxPath = join(root, ".rc", "outbox.json");
  if (session) {
    saveOutbox(outboxPath, createOutbox({
      session_id: session, project_ref: projectRefFor(root), device_id: "dev-test", epoch: 1, project_root: root,
    }));
  }
  return {
    root,
    outboxPath,
    history: historyPaths(join(root, "aether-output")),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

interface StoredEvent { seq: number; host_event_id: string; event_type: string; payload: Record<string, unknown> }

/**
 * A contract-checking broker. It dedupes on host_event_id the way the Cloud
 * store does, so a resent batch is stored once, and `viewerArtifacts` reduces
 * the stored history exactly like site/components/remote-session/viewerState.ts.
 */
function broker(session: string = SESSION) {
  const stored: StoredEvent[] = [];
  let seq = 0;
  let mode: "online" | "offline" | "lose-response" = "online";
  let gate: Promise<void> | null = null;
  const calls: number[] = [];
  const api = {
    async postJson(endpoint: string, body: unknown) {
      assert.equal(endpoint, `/remote/sessions/${session}/host/events`);
      const events = (body as { events: Array<Omit<StoredEvent, "seq">> }).events;
      calls.push(events.length);
      if (gate) {
        const wait = gate;
        gate = null;
        await wait;
      }
      if (mode === "offline") throw new Error("broker offline");
      for (const event of events) {
        const violation = event.event_type === "artifact" ? cloudArtifactViolation(event.payload) : null;
        if (violation) throw Object.assign(new Error("rejected"), { status: 400, detail: violation });
      }
      const receipts = events.map((event) => {
        let row = stored.find((candidate) => candidate.host_event_id === event.host_event_id);
        if (!row) {
          row = { seq: ++seq, ...event };
          stored.push(row);
        }
        return { host_event_id: event.host_event_id, seq: row.seq, payload_digest: payloadDigest(event.payload) };
      });
      if (mode === "lose-response") {
        mode = "online";
        throw new Error("connection reset after the broker stored the batch");
      }
      return { session_id: session, receipts };
    },
  } as unknown as ApiClient;
  return {
    api,
    stored,
    calls,
    setMode(next: typeof mode) { mode = next; },
    /** Hold the next append until the returned release() is called. */
    holdNext(): () => void {
      let release!: () => void;
      gate = new Promise<void>((done) => { release = done; });
      return release;
    },
    viewerArtifacts(): Array<Record<string, unknown>> {
      let artifacts: Array<Record<string, unknown>> = [];
      for (const event of [...stored].sort((a, b) => a.seq - b.seq)) {
        if (event.event_type !== "artifact") continue;
        artifacts = [event.payload, ...artifacts.filter((a) => a["artifact_id"] !== event.payload["artifact_id"])];
      }
      return artifacts;
    },
  };
}

/** Commit through the real seam, publishing the way production does. */
function commitAndPublish(box: Sandbox, api: ApiClient, over: Partial<AppendInput> = {}): {
  entry: MediaEntry;
  delivered: Promise<void>;
} {
  let delivered: Promise<void> = Promise.resolve();
  const result = appendEntry(box.history, input(over), {
    now: NOW,
    onCommitted: (committed) => {
      delivered = publishArtifactEntry(api, box.root, box.outboxPath, committed);
    },
  });
  return { entry: result.entry, delivered };
}

// ── 1. The commit seam ──────────────────────────────────────────────────────

test("the commit observer sees the entry only after it is durably committed and the lock is released", () => {
  const box = sandbox(null);
  try {
    const seen: MediaEntry[] = [];
    const { entry: appended } = appendEntry(box.history, input(), {
      now: NOW,
      onCommitted: (committed) => {
        const onDisk = loadHistory(box.history, NOW);
        assert.ok(onDisk.doc.entries.some((e) => e.artifactId === committed.artifactId),
          "the observed entry is already in the committed generation");
        assert.equal(readdirSync(dirname(box.history.lock)).includes(".genlog.json.lock"), false,
          "the media-history lock is released before RC runs");
        seen.push(committed);
      },
    });
    assert.deepEqual(seen, [appended]);
  } finally {
    box.cleanup();
  }
});

test("a failing commit is never observed, and a throwing observer cannot undo a commit", () => {
  const box = sandbox(null);
  try {
    appendEntry(box.history, input(), { now: NOW }); // creates the output directory
    writeFileSync(box.history.primary, JSON.stringify({
      schemaVersion: MEDIA_HISTORY_SCHEMA_VERSION + 1, generation: 1, nextSequence: "1", updatedAt: NOW, entries: [],
    }));
    let observed = 0;
    assert.throws(() => appendEntry(box.history, input(), { now: NOW, onCommitted: () => { observed += 1; } }),
      /newer Aether/);
    assert.equal(observed, 0, "nothing was committed, so nothing may be published");

    rmSync(box.history.primary, { force: true });
    rmSync(box.history.backup, { force: true });
    const { entry: appended } = appendEntry(box.history, input(), {
      now: NOW,
      onCommitted: () => { throw new Error("RC exploded"); },
    });
    assert.equal(loadHistory(box.history, NOW).doc.entries.at(-1)?.artifactId, appended.artifactId,
      "the artifact stays recorded whatever the observer does");
  } finally {
    box.cleanup();
  }
});

// ── 2. The projection ──────────────────────────────────────────────────────

test("a committed entry publishes a stable identifier, type and label and nothing private", async () => {
  const box = sandbox();
  const cloud = broker();
  try {
    const { entry: committed, delivered } = commitAndPublish(box, cloud.api);
    await delivered;

    assert.equal(cloud.stored.length, 1);
    const sent = cloud.stored[0]!;
    assert.equal(sent.event_type, "artifact");
    assertCloudAccepts(sent.payload);
    assert.deepEqual(sent.payload, {
      projection_version: "1",
      artifact_id: publicArtifactId(SESSION, committed.artifactId),
      kind: "image",
      title: "hero.png",
      summary: "image · 2048 bytes",
    });
    assert.match(String(sent.payload["artifact_id"]), /^artifact-[0-9a-f]{24}$/);
    assert.ok(!JSON.stringify(sent.payload).includes(committed.artifactId),
      "the local history id stays local; only the session-scoped handle travels");
    assertNoLeak(sent.payload);
    assertNoLeak(readFileSync(box.outboxPath, "utf8"));
    assert.equal(loadOutbox(box.outboxPath, box.root).events.length, 0, "a receipted event leaves the queue");
  } finally {
    box.cleanup();
  }
});

test("the public artifact id is stable per entry and session, and differs across either", () => {
  const id = publicArtifactId(SESSION, "entry-1");
  assert.match(id, /^artifact-[0-9a-f]{24}$/);
  assert.equal(publicArtifactId(SESSION, "entry-1"), id);
  assert.notEqual(publicArtifactId(SESSION, "entry-2"), id);
  assert.notEqual(publicArtifactId("rs_" + "b".repeat(32), "entry-1"), id);
});

test("a label that echoes the model or the prompt falls back to a generic one", () => {
  // downloadMediaFile names an unlabelled download `<model>_<timestamp>.png`,
  // and a server-chosen name can be a slug of the prompt. Either would carry
  // exactly what the producer drops on purpose.
  const byModel = artifactEvent(entry({ displayName: "nano_pro_1759660000000.png" }));
  assert.equal(byModel.payload["title"], "Image #7");
  const byPrompt = artifactEvent(entry({ displayName: "A_moody_poster_of_the_operators.png" }));
  assert.equal(byPrompt.payload["title"], "Image #7");
  assertNoLeak(byModel.payload);
  assertNoLeak(byPrompt.payload);
});

test("an empty, path-shaped, URL-shaped or oversized name is reduced to a safe bounded label", () => {
  // Regression: an empty displayName (legal in a migrated v1 log) produced
  // title "" — a Cloud 400 that would wedge every later event in the outbox.
  assert.equal(artifactEvent(entry({ displayName: "" })).payload["title"], "Image #7");
  assert.equal(artifactEvent(entry({ kind: "video", displayName: "  \u0007 " })).payload["title"], "Video #7");
  assert.equal(artifactEvent(entry({ kind: "3d", displayName: ".." })).payload["title"], "3D model #7");
  assert.equal(artifactEvent(entry({ displayName: "C:\\Users\\someone\\out\\hero.png" })).payload["title"], "hero.png");
  assert.equal(artifactEvent(entry({ displayName: "/home/someone/out/hero.png" })).payload["title"], "hero.png");
  assert.equal(artifactEvent(entry({ displayName: "hero.png?token=abc123" })).payload["title"], "hero.png");
  const long = artifactEvent(entry({ displayName: `${"x".repeat(400)}.png` })).payload["title"];
  assert.ok(typeof long === "string" && long.length > 0 && long.length <= 128);
  for (const displayName of ["", "..", "hero\u0000.png", "x".repeat(2000)]) {
    assertCloudAccepts(artifactEvent(entry({ displayName })).payload);
  }
});

test("a label sharing any meaningful word with the prompt is treated as derived from it", () => {
  // Review finding: only a 16-char prompt PREFIX was compared, so a server slug
  // that drops the leading article, reorders, or concatenates the prompt's
  // words carried the operator's own words to the viewer as the title.
  for (const displayName of [
    "moody-poster-of-the-operators.png", // leading article dropped
    "codename_launch_secret.png", // reordered
    "moodyposteroperators.png", // concatenated, no separators
    "sunset-poster.png", // one prompt word is still the prompt's subject
  ]) {
    const payload = artifactEvent(entry({ displayName })).payload;
    assert.equal(payload["title"], "Image #7", displayName);
    assertNoLeak(payload);
    assertCloudAccepts(payload);
  }
  // A short prompt is checked too: three letters can be the whole subject.
  assert.equal(artifactEvent(entry({ prompt: "a red car", displayName: "red_car.png" })).payload["title"], "Image #7");
  // Names that share nothing meaningful with the prompt keep their label.
  for (const displayName of ["hero.png", "IMG_0001.png", "diagram-v2.png", "the-image.png"]) {
    assert.equal(artifactEvent(entry({ displayName })).payload["title"], displayName);
  }
});

test("a capability-shaped object key is never used as the label", () => {
  // With no server filename the label is the media URL's last path segment,
  // which for unguessable-link CDNs IS the capability. It is no name either.
  for (const displayName of [
    "3f2504e0-4f89-11d3-9a0c-0305e82c3301.png",
    "AbCdEf123456GhIjKl7890.png",
    "x7Kp2_Qm9LzR4tVw8YbN-u3.webp",
    "9f86d081884c7d659a2feaa0c55ad015.mp4",
  ]) {
    const payload = artifactEvent(entry({ displayName })).payload;
    assert.equal(payload["title"], "Image #7", displayName);
    assertCloudAccepts(payload);
  }
});

test("a truncated or malformed label never carries half a character", () => {
  // `.slice` counts UTF-16 units: cutting a surrogate pair leaves a lone
  // surrogate, which a UTF-8 canonical-JSON encoder cannot write.
  const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const title = String(artifactEvent(entry({ displayName: `${"\u{1F600}".repeat(100)}.png` })).payload["title"]);
  assert.ok(title.length > 0 && title.length <= 128, title);
  assert.doesNotMatch(title, LONE);
  const lone = String(artifactEvent(entry({ displayName: "bad\uD800name.png" })).payload["title"]);
  assert.doesNotMatch(lone, LONE);
});

test("an unknown size is not reported as zero bytes", () => {
  // recordOutput stores 0 when the download cannot be stat'ed: "size unknown".
  for (const sizeBytes of [0, -1, 1.5, Number.MAX_VALUE]) {
    const payload = artifactEvent(entry({ sizeBytes })).payload;
    assert.equal(payload["summary"], undefined, `size ${sizeBytes}`);
    assertCloudAccepts(payload);
  }
  assert.equal(artifactEvent(entry({ kind: "video", sizeBytes: 5 })).payload["summary"], "video · 5 bytes");
});

// ── 3. Delivery ─────────────────────────────────────────────────────────────

test("no active session means no outbox write and no network", async () => {
  for (const state of ["none", "revoked", "foreign-root"] as const) {
    const box = sandbox(state === "none" ? null : SESSION);
    const cloud = broker();
    try {
      if (state === "revoked") {
        const record = loadOutbox(box.outboxPath, box.root);
        record.revoke_pending = true;
        saveOutbox(box.outboxPath, record);
      }
      if (state === "foreign-root") {
        const record = loadOutbox(box.outboxPath, box.root);
        record.project_root = join(box.root, "elsewhere");
        saveOutbox(box.outboxPath, record);
      }
      const before = state === "none" ? null : readFileSync(box.outboxPath, "utf8");
      const { delivered } = commitAndPublish(box, cloud.api);
      await delivered;
      assert.equal(cloud.calls.length, 0, state);
      if (before === null) assert.throws(() => readFileSync(box.outboxPath), state);
      else assert.equal(readFileSync(box.outboxPath, "utf8"), before, state);
    } finally {
      box.cleanup();
    }
  }
});

test("an offline broker leaves the artifact durable, and reconnect delivers it exactly once", async () => {
  const box = sandbox();
  const cloud = broker();
  try {
    cloud.setMode("offline");
    const first = commitAndPublish(box, cloud.api, { displayName: "one.png" });
    await first.delivered;
    const queued = loadOutbox(box.outboxPath, box.root).events;
    assert.equal(queued.length, 1, "the event is on disk before any network attempt");
    assertNoLeak(queued);

    // The broker stores the batch but the response never arrives: the cursor
    // must not move, and the resend must not create a second artifact.
    cloud.setMode("lose-response");
    const second = commitAndPublish(box, cloud.api, { displayName: "two.png" });
    await second.delivered;
    assert.equal(loadOutbox(box.outboxPath, box.root).events.length, 2, "an unproven batch is kept");

    const third = commitAndPublish(box, cloud.api, { displayName: "three.png" });
    await third.delivered;
    assert.equal(loadOutbox(box.outboxPath, box.root).events.length, 0);
    assert.deepEqual(cloud.stored.map((e) => e.payload["title"]), ["one.png", "two.png", "three.png"],
      "host_event_id dedupe stores each replayed event once");
    assert.deepEqual(cloud.viewerArtifacts().map((a) => a["title"]), ["three.png", "two.png", "one.png"]);
    for (const event of cloud.stored) assertCloudAccepts(event.payload);
  } finally {
    box.cleanup();
  }
});

test("republishing the same history entry updates one artifact in the viewer", async () => {
  const box = sandbox();
  const cloud = broker();
  try {
    const { entry: committed, delivered } = commitAndPublish(box, cloud.api);
    await delivered;
    await publishArtifactEntry(cloud.api, box.root, box.outboxPath, committed);
    assert.equal(cloud.stored.length, 2, "two distinct host events");
    assert.equal(cloud.viewerArtifacts().length, 1, "one artifact: the id is derived from the entry");
  } finally {
    box.cleanup();
  }
});

test("an artifact committed while an upload is in flight is never lost", async () => {
  const box = sandbox();
  const cloud = broker();
  try {
    const release = cloud.holdNext();
    const first = commitAndPublish(box, cloud.api, { displayName: "first.png" });
    // A batch generation commits the next file while the first upload waits.
    const second = commitAndPublish(box, cloud.api, { displayName: "second.png" });
    assert.equal(loadOutbox(box.outboxPath, box.root).events.length, 2, "both are durable immediately");
    cloud.setMode("offline");
    release();
    await Promise.all([first.delivered, second.delivered]);
    // The held append fails once released, so nothing is stored yet — and
    // nothing queued was overwritten either.
    assert.equal(loadOutbox(box.outboxPath, box.root).events.length, 2);

    const release2 = cloud.holdNext();
    cloud.setMode("online");
    const third = commitAndPublish(box, cloud.api, { displayName: "third.png" });
    const fourth = commitAndPublish(box, cloud.api, { displayName: "fourth.png" });
    release2();
    await Promise.all([third.delivered, fourth.delivered]);
    assert.equal(loadOutbox(box.outboxPath, box.root).events.length, 0);
    assert.deepEqual(cloud.viewerArtifacts().map((a) => a["title"]).sort(),
      ["first.png", "fourth.png", "second.png", "third.png"]);
  } finally {
    box.cleanup();
  }
});

test("an upload that succeeds after a later commit does not erase that commit", async () => {
  // Regression: two loaders each saving their own copy of the outbox let the
  // first upload's receipt write drop the second artifact from disk.
  const box = sandbox();
  const cloud = broker();
  try {
    const release = cloud.holdNext();
    const first = commitAndPublish(box, cloud.api, { displayName: "first.png" });
    const second = commitAndPublish(box, cloud.api, { displayName: "second.png" });
    // The first append is already in flight. Every append after it fails, so
    // only the outbox can still hold the second artifact once it is released.
    (cloud.api as unknown as { postJson: () => Promise<never> }).postJson = async () => {
      throw new Error("broker offline");
    };
    release();
    await Promise.all([first.delivered, second.delivered]);
    const left = loadOutbox(box.outboxPath, box.root).events;
    assert.deepEqual(left.map((event) => event.payload["title"]), ["second.png"],
      "the first receipt removed only the first artifact");
  } finally {
    box.cleanup();
  }
});

test("a broken outbox or transport never changes the media command's result", async () => {
  const box = sandbox();
  try {
    writeFileSync(box.outboxPath, "{ not json");
    const throwing = { async postJson() { throw new Error("must not be called"); } } as unknown as ApiClient;
    const { entry: committed, delivered } = commitAndPublish(box, throwing);
    await delivered;
    assert.equal(loadHistory(box.history, NOW).doc.entries[0]?.artifactId, committed.artifactId);
    assert.equal(readFileSync(box.outboxPath, "utf8"), "{ not json", "an unreadable outbox is not overwritten");
  } finally {
    box.cleanup();
  }
});

test("an idle artifact publisher never erases another writer's queued events", async () => {
  // One outbox, two writers, broker offline. The coding observer queues a plan
  // event; then artifacts are committed. With no upload of its own in flight
  // the artifact publisher must start from the outbox on disk, never from a
  // copy that predates the other writer's save.
  const box = sandbox();
  const cloud = broker();
  cloud.setMode("offline");
  try {
    const observer = openRcCodingObserver(box.root, cloud.api, box.outboxPath);
    assert.ok(observer, "the coding observer attaches to the active session");
    observer.feed({ type: "stage", name: "execute", face: "" });
    await observer.drain();
    assert.deepEqual(loadOutbox(box.outboxPath, box.root).events.map((event) => event.event_type), ["plan"]);

    const first = commitAndPublish(box, cloud.api, { displayName: "one.png" });
    await first.delivered;
    const second = commitAndPublish(box, cloud.api, { displayName: "two.png" });
    await second.delivered;
    const queued = loadOutbox(box.outboxPath, box.root).events;
    assert.deepEqual(queued.map((event) => event.event_type), ["plan", "artifact", "artifact"]);
    assert.deepEqual(queued.slice(1).map((event) => event.payload["title"]), ["one.png", "two.png"]);
    assert.equal(cloud.stored.length, 0);
  } finally {
    box.cleanup();
  }
});

// ── 4. Production wiring ───────────────────────────────────────────────────

test("/photogen publishes the generated artifact to the active RC session", async () => {
  const root = resolve(mkdtempSync(join(tmpdir(), "aether-rc-photogen-")));
  const configDir = mkdtempSync(join(tmpdir(), "aether-rc-config-"));
  const previousCwd = process.cwd();
  const previousConfig = process.env["AETHER_CONFIG_DIR"];
  process.env["AETHER_CONFIG_DIR"] = configDir;
  const outboxPath = rcOutboxPath(projectRefFor(root));
  saveOutbox(outboxPath, createOutbox({
    session_id: SESSION, project_ref: projectRefFor(root), device_id: "dev-test", epoch: 1, project_root: root,
  }));
  const cloud = broker();
  let uploaded!: () => void;
  const upload = new Promise<void>((done) => { uploaded = done; });
  const api = {
    async postJson(endpoint: string, body: unknown, ...rest: unknown[]) {
      if (endpoint === "/agent/chat") {
        return { media_url: `https://cdn.example/media/out.png?X-Amz-Signature=${SIGNED}`, filename: "sunset-hero.png" };
      }
      try {
        return await (cloud.api.postJson as (...args: unknown[]) => Promise<unknown>)(endpoint, body, ...rest);
      } finally {
        uploaded();
      }
    },
    async getBinary() {
      return { body: Readable.from([Buffer.from("PNGDATA")]) };
    },
  } as unknown as ApiClient;
  const ctx = { api, flags: { cwd: root, json: false } } as unknown as AppContext;
  let printed = "";
  const out = new Writable({ write(chunk, _enc, done) { printed += String(chunk); done(); } });
  try {
    process.chdir(root);
    await photogenSlash(ctx, out, `${PROMPT} --model nano`, false);
    // Bounded: a command that never publishes must fail here, not hang the run.
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([upload, new Promise<void>((_, reject) => {
      timer = setTimeout(() => reject(new Error("no RC upload after /photogen")), 5_000);
      timer.unref();
    })]).finally(() => clearTimeout(timer));
    assert.match(printed, /sunset-hero\.png/, "the local command result is unchanged");
    assert.equal(cloud.stored.length, 1);
    const payload = cloud.stored[0]!.payload;
    assertCloudAccepts(payload);
    assert.equal(payload["title"], "sunset-hero.png");
    assert.equal(payload["kind"], "image");
    assert.equal(payload["summary"], "image · 7 bytes");
    assertNoLeak(payload);
    assert.ok(!JSON.stringify(payload).includes(root), "no absolute local path");
  } finally {
    process.chdir(previousCwd);
    if (previousConfig === undefined) delete process.env["AETHER_CONFIG_DIR"];
    else process.env["AETHER_CONFIG_DIR"] = previousConfig;
    rmSync(root, { recursive: true, force: true });
    rmSync(configDir, { recursive: true, force: true });
  }
});

test("every media command that records history hands the commit to RC", () => {
  // A new recordOutput call that skips the observer would silently publish
  // nothing; pin that each production call carries it.
  const dir = join(REPO, "src", "commands");
  const offenders: string[] = [];
  let calls = 0;
  for (const name of readdirSync(dir).filter((file) => file.endsWith(".ts"))) {
    const lines = readFileSync(join(dir, name), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (!/\brecordOutput\(/.test(line)) return;
      calls += 1;
      if (!/onCommitted: rcArtifactObserver\(ctx\)/.test(line)) offenders.push(`${name}:${index + 1}`);
    });
  }
  assert.ok(calls >= 2, "media.ts and slash_media.ts both record history");
  assert.deepEqual(offenders, []);
});
