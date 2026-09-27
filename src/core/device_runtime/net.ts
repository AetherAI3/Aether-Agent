// Device network — the daemon's ONLY outbound surface. Every call is a bounded
// HTTPS request to the Cloud carrying the device token as a bearer; the device
// never listens on a port. The fetch implementation is injected so the whole
// surface is tested without a socket, and the same credential-safety rule the
// session client uses applies: a bearer is only ever attached over https (or
// loopback http for a local dev backend).

import { isCredentialSafeUrl } from "../transport.js";
import {
  DEVICE_COMMANDS_POLL_PATH,
  DEVICE_GROUPS_PATH,
  DEVICE_HANDOFF_PATH,
  DEVICE_HEALTH_PATH,
  DEVICE_OBSERVE_PATH,
  deviceCommandResultPath,
  type CommandResult,
  type DeviceCommand,
  type DeviceObservation,
  type ProcessGroupRegistration,
  type WorkspaceHandoffV1,
} from "./contract.js";
import type { PublishOutcome } from "./publisher.js";

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface DeviceNetOptions {
  fetchImpl?: FetchLike;
  requestTimeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class DeviceNet {
  private readonly fetchImpl: FetchLike;
  private readonly timeoutMs: number;

  constructor(
    private readonly baseUrl: string,
    private readonly deviceToken: string,
    opts: DeviceNetOptions = {},
  ) {
    if (!isCredentialSafeUrl(baseUrl)) {
      throw new Error("device runtime refuses an insecure base URL (bearer would traverse cleartext)");
    }
    this.fetchImpl = opts.fetchImpl ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  private url(path: string): string {
    return this.baseUrl.replace(/\/$/, "") + path;
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.deviceToken}`, "Content-Type": "application/json", Accept: "application/json" };
  }

  private signal(): AbortSignal {
    return AbortSignal.timeout(this.timeoutMs);
  }

  /**
   * Publish one observation. Maps the HTTP result onto the publisher's outcome:
   * a 2xx is ok; a 4xx the Cloud used to decline the frame (stale, duplicate,
   * unprocessable) is a reject — never re-sent; a network error, timeout, 408 or
   * 5xx is a retry, which keeps the frame queued and arms backoff.
   */
  async observe(obs: DeviceObservation): Promise<PublishOutcome> {
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(DEVICE_OBSERVE_PATH), {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify(obs),
        signal: this.signal(),
      });
    } catch {
      return "retry";
    }
    if (res.ok) return "ok";
    if (res.status === 408 || res.status === 429 || res.status >= 500) return "retry";
    return "reject";
  }

  /** Long-poll for commands. Returns [] on timeout/no-content; throws on error. */
  async pollCommands(waitSeconds = 25): Promise<DeviceCommand[]> {
    const res = await this.fetchImpl(`${this.url(DEVICE_COMMANDS_POLL_PATH)}?wait=${encodeURIComponent(String(waitSeconds))}`, {
      method: "GET",
      headers: this.headers(),
      // The server holds the request up to `wait` seconds; allow slack over it.
      signal: AbortSignal.timeout((waitSeconds + 10) * 1000),
    });
    if (res.status === 204) return [];
    if (!res.ok) throw new Error(`command poll failed: HTTP ${res.status}`);
    const body: unknown = await res.json().catch(() => null);
    if (Array.isArray(body)) return body as DeviceCommand[];
    if (body && typeof body === "object") {
      const commands = (body as Record<string, unknown>)["commands"];
      if (Array.isArray(commands)) return commands as DeviceCommand[];
      if ((body as Record<string, unknown>)["schema"] === "aether.device.command/1") return [body as DeviceCommand];
    }
    return [];
  }

  async postResult(result: CommandResult): Promise<void> {
    const res = await this.fetchImpl(this.url(deviceCommandResultPath(result.command_id)), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(result),
      signal: this.signal(),
    });
    if (!res.ok) throw new Error(`posting command result failed: HTTP ${res.status}`);
  }

  async registerGroup(reg: ProcessGroupRegistration): Promise<void> {
    const res = await this.fetchImpl(this.url(DEVICE_GROUPS_PATH), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(reg),
      signal: this.signal(),
    });
    if (!res.ok) throw new Error(`registering managed group failed: HTTP ${res.status}`);
  }

  async offerHandoff(handoff: WorkspaceHandoffV1): Promise<void> {
    const res = await this.fetchImpl(this.url(DEVICE_HANDOFF_PATH), {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify(handoff),
      signal: this.signal(),
    });
    if (!res.ok) throw new Error(`offering workspace handoff failed: HTTP ${res.status}`);
  }

  /** Reachability probe for `aether device doctor`. Never throws. */
  async health(): Promise<{ reachable: boolean; status: number | null; latencyMs: number }> {
    const started = Date.now();
    try {
      const res = await this.fetchImpl(this.url(DEVICE_HEALTH_PATH), {
        method: "GET",
        headers: this.headers(),
        signal: this.signal(),
      });
      return { reachable: res.ok, status: res.status, latencyMs: Date.now() - started };
    } catch {
      return { reachable: false, status: null, latencyMs: Date.now() - started };
    }
  }
}
