// Shared types for the Aether Agent CLI.
// The CLI is a thin front door: it never enforces UVT or signs anything.
// Aether's servers do enforcement and signing. The client only
// builds requests, streams frames, renders, and applies edits locally.

export type PermissionMode = "ask" | "auto" | "skip";

/** Brain selection: 'auto' = cloud when signed in, local Ollama when not. */
export type BackendPref = "auto" | "local" | "cloud";

export interface AetherConfig {
  /** the Aether API base URL. The only host the CLI talks to. */
  baseUrl: string;
  /** Default model id when --model is not passed (server smart-routes if empty). */
  defaultModel: string;
  /** Namespaced local selection (`ollama:<tag>`). Kept separate so choosing a
   * local model cannot rewrite or leak into the hosted default. */
  localModel?: string;
  /** Edit/command gating. Mirrors Aether Agent desktop "skip-perms" setting. */
  permissionMode: PermissionMode;
  /** Auto-apply streamed edits without per-edit prompt. Mirrors Aether Agent. */
  autoApply: boolean;
  /** Anonymous usage telemetry opt-in. */
  telemetry: boolean;
  /** Default effort tier (LOW|MED|MAX|ULTRA|CODEPRO, "" = server default).
   * Shared with the AetherCloud backend: rides TaskCommand.effort into the
   * cloud brain on every `aether code` run when --effort is not passed. */
  defaultEffort: string;
  /** Which brain runs a turn. 'auto' is local-first: cloud when authed, else
   * local Ollama. Overridden per-process by the AETHER_BACKEND env var. */
  backend: BackendPref;
  /** Dev-only persistent device runtime (SC-DEVICE-01). Absent or
   * `{enabled:false}` keeps the daemon fully OFF — it refuses to run unless
   * this is explicitly true or the env override AETHER_DEVICE_RUNTIME=1 is set.
   * Outbound-only telemetry/command service; never listens on a network port. */
  deviceRuntime?: DeviceRuntimeConfig;
}

/** Operator opt-in for the persistent device runtime. Default-off by omission. */
export interface DeviceRuntimeConfig {
  /** The one switch that lets the daemon run at all. Absent or false keeps it
   * off; the AETHER_DEVICE_RUNTIME=1 env var is the other opt-in. */
  enabled?: boolean;
  /** Display-only device name sent as observation `display_name`; never identity. */
  displayName?: string;
  /** Declared lane capacity this device offers, published as `lanes_reserved`
   * so the Cloud can see headroom. Omitted means "only what is running". */
  lanes?: number;
}

// Wire DTO from GET /models (snake_case mirrors the server catalog). A single
// list unifies chat models and orchestrators (Neo/Kronus) via `kind`.
export interface CatalogItem {
  id: string;
  label: string;
  kind: "model" | "orchestrator";
  provider: string | null;
  context_window: number | null;
  /** Lowest tier that can use it: free | solo | pro | team. */
  tier_min: string | null;
  /** Provider/env gate satisfied. */
  enabled: boolean;
  /** enabled AND the caller's tier includes it. */
  available: boolean;
  /** Hard monthly UVT ceiling on the caller's tier, or null if uncapped. */
  monthly_uvt_cap: number | null;
  /**
   * The ceiling this model would carry on `tier_min` — the number that argues
   * for upgrading. On a locked row `monthly_uvt_cap` is null by construction
   * (it answers for the caller's tier, which does not include the model), so
   * this is the only cap a locked row can show. Optional: older servers omit it.
   */
  unlock_uvt_cap?: number | null;
  is_default: boolean;
}

export interface CatalogResponse {
  models: CatalogItem[];
  tier: string;
  default: string;
}
