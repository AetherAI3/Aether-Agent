export interface NativeOptions { python?: string; env?: Record<string, string | undefined>; signal?: AbortSignal; }
export interface MemoryOptions extends NativeOptions { agentId: string; directory: string; sizeGb: number; bootstrap?: boolean; ownerScope?: { cloudOrigin: string; accountSubject: string }; }
export interface MemoryReceipt extends Record<string, unknown> { state: "ready" | "unavailable"; agent_id?: string; directory?: string; size_gb?: number; ceiling_bytes?: number; persistence_verified?: boolean; runtime_version?: string; code?: string; lock_scope?: "ats_setup_only"; runtime_exclusivity_verified?: false; verification_kind?: "native_pool_init_and_snapshot_reopen" | "persisted_snapshot_reopen"; owner_scope?: { account_subject: string; cloud_origin: string }; }
export interface StrategyRecord { file: string; state: "compiled" | "rejected" | "needs_conversion" | "unavailable"; source_sha256?: string; source_bytes?: number; code?: string; diagnostics?: Array<{line: number; column: number; message: string; severity: string}>; [key: string]: unknown; }
export interface StrategyScan extends Record<string, unknown> { state: "scanned"; directory: string; compiler: "native_ats" | "unavailable"; strategies: StrategyRecord[]; execution_enabled: false; recursive: false; }
export declare function initializeMemory(options: MemoryOptions): Promise<MemoryReceipt>;
export interface MemoryWriterLeaseReceipt { schema_version: 'aether.ats.memory-writer-lease/1'; state: 'leased'; lease_id: string; agent_id: string; directory: string; owner_scope: { account_subject: string; cloud_origin: string }; pid: number; started_at: string; lock_scope: 'ats_runtime_writer'; runtime_exclusivity_verified: true; }
export interface MemoryWriterLease { receipt: MemoryWriterLeaseReceipt; close(): Promise<void>; }
export declare function acquireMemoryWriterLease(options: MemoryOptions): Promise<MemoryWriterLease>;
export declare function scanStrategies(options: NativeOptions & { directory: string }): Promise<StrategyScan>;
export interface BundledStrategy { id: string; name: string; category: string; ir_maturity: string; required_host_signals: string[]; starter: boolean; }
export declare const NANO_LIBRARY_REVISION: string;
export declare const STARTER_STRATEGIES: readonly string[];
export declare function listBundledStrategies(options?: { category?: string }): Promise<{ schema_version: 'aether.ats.nano-library-list/1'; repository: string; revision: string; nano_version: string; strategies: BundledStrategy[]; performance_claimed: false; execution_enabled: false }>;
export declare function installBundledStrategies(options: { directory: string; selection?: 'starter' | 'all'; ids?: string[] }): Promise<{ schema_version: 'aether.ats.nano-library-install/1'; repository: string; revision: string; nano_version: string; directory: string; installed: Array<{id: string; file: string}>; execution_enabled: false; permission_granted: false }>;
export interface AtsJournalEvent { agentId: string; type: string; level?: 'info' | 'warning' | 'error'; summary: string; details?: Record<string, string | number | boolean | null>; }
export interface AtsJournalRow { schema_version: 'aether.ats.journal/1'; event_id: string; recorded_at: string; agent_id: string; type: string; level: 'info' | 'warning' | 'error'; summary: string; details: Record<string, string | number | boolean | null>; }
export declare function appendJournalEvent(file: string, event: AtsJournalEvent, options?: { now?: () => Date }): Promise<AtsJournalRow>;
export declare function readJournal(file: string, options?: { limit?: number }): Promise<AtsJournalRow[]>;
export declare function formatJournal(rows: AtsJournalRow[], options?: { json?: boolean }): string;
export declare function validateBrowserUrl(value: string, base?: string): string;
export interface BrowserObservation {
  sequence: number; capturedAt: string; origin: string; title: string;
  screenshotBytes: number; width: number; height: number;
}
export interface BrowserStatus { state: string; sessionId: string | null; viewUrl: string | null; viewerState: string; ageMs: number | null; visionStepsRemaining: number | null; expiresAt: string | null; observation: BrowserObservation | null; }
export interface BrowserRecoveryOwner { origin: string; accountSubject: string; agentId: string; deviceId: string; }
export interface BrowserRecoveryStatus { state: "none" | "opening" | "owned" | "cleanup_required" | "closed" | "expired"; pending: boolean; sessionId: string | null; expiresAt: string | null; baseUrl: string; outcome: string | null; }
export declare class BrowserSessionRecovery {
  constructor(options: { directory: string; owner: BrowserRecoveryOwner; baseUrl: string; now?: () => number });
  status(): Promise<BrowserRecoveryStatus>;
  begin(options: { maxVisionSteps: number; maxAgeMs: number }): Promise<void>;
  record(session: { id: string; createdAt: string; expiresAt: string; maxVisionSteps: number }): Promise<void>;
  markCleanupRequired(): Promise<void>;
  reconcile(browser: unknown, options?: { signal?: AbortSignal }): Promise<BrowserRecoveryStatus>;
}
export declare class AtsBrowserObserver {
  constructor(options: { browser: unknown; baseUrl: string; maxVisionSteps?: number; maxAgeMs?: number; now?: () => number; recovery?: BrowserSessionRecovery });
  open(options?: { signal?: AbortSignal }): Promise<{ sessionId: string; viewUrl: string | null; state: string }>;
  snapshot(options?: { signal?: AbortSignal }): Promise<unknown>;
  close(): Promise<void>;
  reconcile(options?: { signal?: AbortSignal }): Promise<BrowserRecoveryStatus | undefined>;
  status(): BrowserStatus;
}
export declare function createBrowserObserver(options?: { env?: Record<string,string | undefined>; maxVisionSteps?: number; maxAgeMs?: number; recovery?: BrowserSessionRecovery }): Promise<AtsBrowserObserver>;
export declare function observeBrowser(observer: AtsBrowserObserver, options?: { intervalMs?: number; signal?: AbortSignal }): AsyncGenerator<unknown>;
export declare function createBrowserFetch(options?: { fetch?: typeof globalThis.fetch; timeoutMs?: number; maxResponseBytes?: number }): typeof globalThis.fetch;
export interface BrowserVisualContext {
  schema_version: 'aether.browser.visual/1'; trust: 'untrusted_page_data'; authority: 'observation_only';
  source: { session_id: string; sequence: number; captured_at: string; origin: string; image_sha256: string; width: number; height: number; vision_steps_remaining: number };
  image: { mime_type: 'image/png'; data: string };
  page: { title: string; text: string; truncated: boolean };
}
export declare function createBrowserVisionSkill(observer: AtsBrowserObserver): {
  readonly name: 'aether_browser_observe'; readonly description: string; readonly input_schema: Record<string, unknown>;
  invoke(input?: { max_text_chars?: number }, options?: { signal?: AbortSignal }): Promise<BrowserVisualContext>;
};
export declare function defaultSettings(): Record<string, unknown>;
export declare function validateSettings(value: unknown): Record<string, unknown>;
export declare function cyclePermissionMode(mode: string): string;
export declare function loadSettings(file: string): Promise<Record<string, unknown>>;
export declare function saveSettings(file: string, value: unknown): Promise<void>;
export declare function validateDataEndpoint(value: unknown): string | null;
export declare function dataStreamStatus(value: unknown, options?: Record<string,unknown>): Record<string,unknown>;
export declare function probeDataStream(value: unknown, probe: (settings: unknown, options: {signal: AbortSignal}) => Promise<unknown>, options?: Record<string,unknown>): Promise<Record<string,unknown>>;
export declare const SETTINGS_SCHEMA: string;
export declare const PERMISSION_MODES: readonly string[];
