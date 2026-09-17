export interface NativeOptions { python?: string; env?: Record<string, string | undefined>; }
export interface MemoryOptions extends NativeOptions { agentId: string; directory: string; sizeGb: number; bootstrap?: boolean; }
export interface MemoryReceipt extends Record<string, unknown> { state: "ready" | "unavailable"; agent_id?: string; directory?: string; size_gb?: number; ceiling_bytes?: number; persistence_verified?: boolean; }
export interface StrategyRecord { file: string; state: "compiled" | "rejected" | "needs_conversion" | "unavailable"; source_sha256?: string; source_bytes?: number; code?: string; diagnostics?: Array<{line: number; column: number; message: string; severity: string}>; [key: string]: unknown; }
export interface StrategyScan extends Record<string, unknown> { state: "scanned"; directory: string; compiler: "native_ats" | "unavailable"; strategies: StrategyRecord[]; execution_enabled: false; recursive: false; }
export declare function initializeMemory(options: MemoryOptions): Promise<MemoryReceipt>;
export declare function scanStrategies(options: NativeOptions & { directory: string }): Promise<StrategyScan>;
export declare function validateBrowserUrl(value: string, base?: string): string;
export interface BrowserStatus { state: string; sessionId: string | null; viewUrl: string | null; viewerState: string; ageMs: number | null; visionStepsRemaining: number | null; }
export declare class AtsBrowserObserver {
  constructor(options: { browser: unknown; baseUrl: string; maxVisionSteps?: number; maxAgeMs?: number; now?: () => number });
  open(): Promise<{ sessionId: string; viewUrl: string | null; state: string }>;
  snapshot(options?: { signal?: AbortSignal }): Promise<unknown>;
  close(): Promise<void>;
  status(): BrowserStatus;
}
export declare function createBrowserObserver(options?: { env?: Record<string,string | undefined>; maxVisionSteps?: number; maxAgeMs?: number }): Promise<AtsBrowserObserver>;
export declare function observeBrowser(observer: AtsBrowserObserver, options?: { intervalMs?: number; signal?: AbortSignal }): AsyncGenerator<unknown>;
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
