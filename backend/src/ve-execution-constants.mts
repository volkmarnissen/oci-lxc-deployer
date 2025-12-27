// Re-export IOutput for backward compatibility
export type { IOutput } from "./output-processor.mjs";

export interface IProxmoxRunResult {
  lastSuccessIndex: number;
}

export interface IRestartInfo {
  vm_id?: string | number | undefined;
  lastSuccessfull: number;
  inputs: { name: string; value: string | number | boolean }[];
  outputs: { name: string; value: string | number | boolean }[];
  defaults: { name: string; value: string | number | boolean }[];
}

/**
 * Execution constants for VeExecution.
 */
export class VeExecutionConstants {
  static readonly DEFAULT_SCRIPT_TIMEOUT_MS = 120000; // 2 minutes
  static readonly HOST_PROBE_TIMEOUT_MS = 10000; // 10 seconds
  static readonly RETRY_DELAY_MS = 3000; // 3 seconds
  static readonly MAX_RETRIES = 3;
  static readonly RESULT_OK = "OK";
  static readonly RESULT_ERROR = "ERROR";
  static readonly SSH_EXIT_CODE_CONNECTION_ERROR = 255;
}

/**
 * Global message index counter.
 */
let globalMessageIndex = 0;

/**
 * Gets and increments the global message index.
 */
export function getNextMessageIndex(): number {
  return globalMessageIndex++;
}

/**
 * Resets the global message index (mainly for testing).
 */
export function resetMessageIndex(): void {
  globalMessageIndex = 0;
}

