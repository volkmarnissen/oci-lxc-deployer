import { EventEmitter } from "events";
import { ICommand, IVeExecuteMessage } from "./types.mjs";
import { VeExecutionConstants } from "./ve-execution-constants.mjs";
import { getNextMessageIndex } from "./ve-execution-constants.mjs";

/**
 * Handles message emission for VeExecution.
 */
export class VeExecutionMessageEmitter {
  constructor(private eventEmitter: EventEmitter) {}

  /**
   * Emits a partial message for streaming output.
   */
  emitPartialMessage(
    tmplCommand: ICommand,
    input: string,
    result: string | null,
    stderr: string,
  ): void {
    this.eventEmitter.emit("message", {
      command: tmplCommand.name || "streaming",
      commandtext: input,
      stderr,
      result,
      exitCode: -1, // Not finished yet
      execute_on: tmplCommand.execute_on,
      partial: true,
    } as IVeExecuteMessage);
  }

  /**
   * Creates and emits a standard message.
   */
  emitStandardMessage(
    cmd: ICommand,
    stderr: string,
    result: string | null,
    exitCode: number,
    index: number,
    hostname?: string,
  ): void {
    this.eventEmitter.emit("message", {
      stderr,
      result,
      exitCode,
      command: cmd.name,
      execute_on: cmd.execute_on,
      host: hostname,
      index,
      partial: false,
    } as unknown as IVeExecuteMessage);
  }

  /**
   * Emits an error message for a failed command.
   */
  emitErrorMessage(
    cmd: ICommand,
    error: any,
    msgIndex: number,
    hostname?: string,
  ): void {
    const msg = String(error?.message ?? error);
    this.emitStandardMessage(cmd, msg, null, -1, msgIndex, hostname);
  }
}

