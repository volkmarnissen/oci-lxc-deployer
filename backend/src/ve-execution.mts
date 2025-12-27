import { EventEmitter } from "events";
import { ICommand, IVeExecuteMessage } from "./types.mjs";
import fs from "node:fs";
import { IVEContext, IVMContext } from "./backend-types.mjs";
import { VMContext } from "./storagecontext.mjs";
import { VariableResolver } from "./variable-resolver.mjs";
import { OutputProcessor } from "./output-processor.mjs";
import { JsonError } from "./jsonvalidator.mjs";
import {
  IProxmoxRunResult,
  IRestartInfo,
  IOutput,
  VeExecutionConstants,
  getNextMessageIndex,
} from "./ve-execution-constants.mjs";
import { VeExecutionMessageEmitter } from "./ve-execution-message-emitter.mjs";
import { VeExecutionSshExecutor } from "./ve-execution-ssh-executor.mjs";
import { VeExecutionHostDiscovery } from "./ve-execution-host-discovery.mjs";

// Re-export for backward compatibility
export type { IOutput, IProxmoxRunResult, IRestartInfo };

/**
 * ProxmoxExecution: Executes a list of ICommand objects with variable substitution and remote/container execution.
 */
export class VeExecution extends EventEmitter {

  private commands!: ICommand[];
  private inputs!: Record<string, string | number | boolean>;
  public outputs: Map<string, string | number | boolean> = new Map();
  private outputsRaw?: { name: string; value: string | number | boolean }[];
  private scriptTimeoutMs: number;
  private variableResolver!: VariableResolver;
  private outputProcessor: OutputProcessor;
  private messageEmitter: VeExecutionMessageEmitter;
  private sshExecutor: VeExecutionSshExecutor;
  private hostDiscovery: VeExecutionHostDiscovery;
  
  constructor(
    commands: ICommand[],
    inputs: { id: string; value: string | number | boolean }[],
    private veContext: IVEContext | null,
    private defaults: Map<string, string | number | boolean> = new Map(),
    protected sshCommand: string = "ssh",
  ) {
    super();
    this.commands = commands;
    this.inputs = {};
    for (const inp of inputs) {
      this.inputs[inp.id] = inp.value;
    }
    
    // Get timeout from environment variable, default to 2 minutes
    const envTimeout = process.env.LXC_MANAGER_SCRIPT_TIMEOUT;
    if (envTimeout) {
      const parsed = parseInt(envTimeout, 10);
      if (!isNaN(parsed) && parsed > 0) {
        this.scriptTimeoutMs = parsed * 1000; // Convert seconds to milliseconds
      } else {
        this.scriptTimeoutMs = VeExecutionConstants.DEFAULT_SCRIPT_TIMEOUT_MS;
      }
    } else {
      this.scriptTimeoutMs = VeExecutionConstants.DEFAULT_SCRIPT_TIMEOUT_MS;
    }

    // Initialize helper classes
    this.initializeVariableResolver();
    this.outputProcessor = new OutputProcessor(
      this.outputs,
      this.outputsRaw,
      this.defaults,
      this.sshCommand,
    );
    this.messageEmitter = new VeExecutionMessageEmitter(this);
    this.sshExecutor = new VeExecutionSshExecutor({
      veContext: this.veContext,
      sshCommand: this.sshCommand,
      scriptTimeoutMs: this.scriptTimeoutMs,
      messageEmitter: this.messageEmitter,
      outputProcessor: this.outputProcessor,
      outputsRaw: this.outputsRaw,
      setOutputsRaw: (raw) => {
        this.outputsRaw = raw;
      },
    });
    this.hostDiscovery = new VeExecutionHostDiscovery({
      sshExecutor: this.sshExecutor,
      outputs: this.outputs,
      variableResolver: this.variableResolver,
      runOnLxc: (vm_id, command, tmplCommand) => this.runOnLxc(vm_id, command, tmplCommand),
    });
  }

  /**
   * Initializes or re-initializes the variable resolver with current state.
   */
  private initializeVariableResolver(): void {
    this.variableResolver = new VariableResolver(
      () => this.outputs,
      () => this.inputs,
      () => this.defaults,
    );
  }

  /**
   * Internal method that actually executes the SSH command.
   * This can be overridden by tests, but the default implementation uses sshExecutor.
   */
  private async executeSshCommand(
    input: string,
    tmplCommand: ICommand,
    timeoutMs: number,
    remoteCommand: string[] | undefined,
    uniqueMarker: string,
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const sshArgs = this.sshExecutor.buildSshArgs(remoteCommand);
    const inputWithMarker = `echo "${uniqueMarker}"\n${input}`;

    return await this.sshExecutor.executeWithRetry(
      sshArgs,
      inputWithMarker,
      timeoutMs,
      tmplCommand,
      input,
    );
  }

  /**
   * Executes a command on the Proxmox host via SSH, with timeout. Parses stdout as JSON and updates outputs.
   * @param input The command to execute
   * @param tmplCommand The template command
   * @param timeoutMs Timeout in milliseconds (defaults to scriptTimeoutMs if not provided)
   * @param remoteCommand Optional remote command to prepend
   */
  protected async runOnVeHost(
    input: string,
    tmplCommand: ICommand,
    timeoutMs?: number,
    remoteCommand?: string[],
  ): Promise<IVeExecuteMessage> {
    // Use provided timeout or fall back to scriptTimeoutMs
    const actualTimeout = timeoutMs !== undefined ? timeoutMs : this.scriptTimeoutMs;
    
    // Update sshExecutor for helper methods
    this.sshExecutor = new VeExecutionSshExecutor({
      veContext: this.veContext,
      sshCommand: this.sshCommand,
      scriptTimeoutMs: this.scriptTimeoutMs,
      messageEmitter: this.messageEmitter,
      outputProcessor: this.outputProcessor,
      outputsRaw: this.outputsRaw,
      setOutputsRaw: (raw) => {
        this.outputsRaw = raw;
      },
    });
    const uniqueMarker = this.sshExecutor.createUniqueMarker();
    
    const { stdout, stderr, exitCode } = await this.executeSshCommand(
      input,
      tmplCommand,
      actualTimeout,
      remoteCommand,
      uniqueMarker,
    );

    const msg = this.sshExecutor.createMessageFromResult(input, tmplCommand, stdout, stderr, exitCode);

    try {
      if (stdout.trim().length === 0) {
        const result = this.sshExecutor.handleEmptyOutput(msg, tmplCommand, exitCode, stderr, this);
        if (result) return result;
      } else {
        // Parse and update outputs
        this.outputProcessor.parseAndUpdateOutputs(stdout, tmplCommand, uniqueMarker);
        // Check if outputsRaw was updated
        const outputsRawResult = this.outputProcessor.getOutputsRawResult();
        if (outputsRawResult) {
          this.outputsRaw = outputsRawResult;
        }
      }
    } catch (e: any) {
      msg.index = getNextMessageIndex();
      msg.error = new JsonError(e.message);
      msg.exitCode = -1;
      msg.partial = false;
      this.emit("message", msg);
      throw new Error("An error occurred during command execution.");
    }
    if (exitCode !== 0) {
      throw new Error(
        `Command "${tmplCommand.name}" failed with exit code ${exitCode}: ${stderr}`,
      );
    } else msg.index = getNextMessageIndex();
    msg.partial = false;
    this.emit("message", msg);
    return msg;
  }

  /**
   * Executes a command inside an LXC container via lxc-attach on the Proxmox host.
   * @param vm_id Container ID
   * @param command Command to execute
   * @param tmplCommand The template command
   * @param timeoutMs Timeout in ms (defaults to scriptTimeoutMs if not provided)
   */
  protected async runOnLxc(
    vm_id: string | number,
    command: string,
    tmplCommand: ICommand,
    timeoutMs?: number,
  ): Promise<IVeExecuteMessage> {
    // Pass command and arguments as array
    let lxcCmd: string[] | undefined = ["lxc-attach", "-n", String(vm_id)];
    // For testing: just pass through when using another sshCommand, like /bin/sh
    if (this.sshCommand !== "ssh") lxcCmd = undefined;
    return await this.runOnVeHost(command, tmplCommand, timeoutMs, lxcCmd);
  }

  /**
   * Executes host discovery flow: calls write-vmids-json.sh on VE host, parses used_vm_ids,
   * resolves VMContext by hostname, validates pve and vmid, then runs the provided command inside LXC.
   */
  protected async executeOnHost(
    hostname: string,
    command: string,
    tmplCommand: ICommand,
  ): Promise<void> {
    // Update sshExecutor and hostDiscovery dependencies in case they changed
    this.sshExecutor = new VeExecutionSshExecutor({
      veContext: this.veContext,
      sshCommand: this.sshCommand,
      scriptTimeoutMs: this.scriptTimeoutMs,
      messageEmitter: this.messageEmitter,
      outputProcessor: this.outputProcessor,
      outputsRaw: this.outputsRaw,
      setOutputsRaw: (raw) => {
        this.outputsRaw = raw;
      },
    });
    this.hostDiscovery = new VeExecutionHostDiscovery({
      sshExecutor: this.sshExecutor,
      outputs: this.outputs,
      variableResolver: this.variableResolver,
      runOnLxc: (vm_id, cmd, tmplCmd) => this.runOnLxc(vm_id, cmd, tmplCmd),
    });
    return await this.hostDiscovery.executeOnHost(hostname, command, tmplCommand, this);
  }

  /**
   * Restores state from restart info and returns the starting index.
   */
  private restoreStateFromRestartInfo(restartInfo: IRestartInfo | null): number {
    if (!restartInfo) return 0;

    // Load previous state
    this.outputs.clear();
    this.inputs = {};
    this.defaults.clear();
    const startIdx = restartInfo.lastSuccessfull !== undefined ? restartInfo.lastSuccessfull + 1 : 0;
    
    for (const inp of restartInfo.inputs) {
      this.inputs[inp.name] = inp.value;
    }
    for (const outp of restartInfo.outputs) {
      this.outputs.set(outp.name, outp.value);
    }
    for (const def of restartInfo.defaults) {
      this.defaults.set(def.name, def.value);
    }
    
    // Re-initialize variable resolver with updated state
    this.initializeVariableResolver();
    
    return startIdx;
  }

  /**
   * Handles a skipped command by emitting a message.
   */
  private handleSkippedCommand(cmd: ICommand, msgIndex: number): number {
    this.messageEmitter.emitStandardMessage(
      cmd,
      cmd.description || "Skipped: all required parameters missing",
      null,
      0,
      msgIndex,
    );
    return msgIndex + 1;
  }

  /**
   * Processes a single property entry and sets it in outputs if valid.
   */
  private processPropertyEntry(entry: { id: string; value?: any }): void {
    if (!entry || typeof entry !== "object" || !entry.id || entry.value === undefined) {
      return;
    }
    
    let value = entry.value;
    // Replace variables in value if it's a string
    if (typeof value === "string") {
      value = this.variableResolver.replaceVars(value);
      // Skip property if value is "NOT_DEFINED" (optional parameter not set)
      if (value === "NOT_DEFINED") {
        return; // Skip this property
      }
    }
    // Only set if value is a primitive type (not array)
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      this.outputs.set(entry.id, value);
    }
  }

  /**
   * Handles a properties command by processing all properties and emitting a message.
   */
  private handlePropertiesCommand(cmd: ICommand, msgIndex: number): number {
    try {
      if (Array.isArray(cmd.properties)) {
        // Array of {id, value} objects
        for (const entry of cmd.properties) {
          this.processPropertyEntry(entry);
        }
      } else if (cmd.properties && typeof cmd.properties === "object" && "id" in cmd.properties) {
        // Single object with id and value
        this.processPropertyEntry(cmd.properties as { id: string; value?: any });
      }
      
      // Emit success message
      const propertiesCmd = { ...cmd, name: cmd.name || "properties" };
      this.messageEmitter.emitStandardMessage(
        propertiesCmd,
        "",
        JSON.stringify(cmd.properties),
        0,
        msgIndex,
      );
      return msgIndex + 1;
    } catch (err: any) {
      const msg = `Failed to process properties: ${err?.message || err}`;
      const propertiesCmd = { ...cmd, name: cmd.name || "properties" };
      this.messageEmitter.emitStandardMessage(propertiesCmd, msg, null, -1, msgIndex);
      return msgIndex + 1;
    }
  }

  /**
   * Loads command content from script file or command string.
   */
  private loadCommandContent(cmd: ICommand): string | null {
    if (cmd.script !== undefined) {
      // Read script file, replace variables, then execute
      return fs.readFileSync(cmd.script, "utf-8");
    } else if (cmd.command !== undefined) {
      return cmd.command;
    }
    return null;
  }

  /**
   * Gets vm_id from inputs or outputs.
   */
  private getVmId(): string | number | undefined {
    if (typeof this.inputs["vm_id"] === "string" || typeof this.inputs["vm_id"] === "number") {
      return this.inputs["vm_id"];
    }
    if (this.outputs.has("vm_id")) {
      const v = this.outputs.get("vm_id");
      if (typeof v === "string" || typeof v === "number") {
        return v;
      }
    }
    return undefined;
  }

  /**
   * Executes a command based on its execute_on target.
   */
  private async executeCommandByTarget(
    cmd: ICommand,
    rawStr: string,
  ): Promise<IVeExecuteMessage | undefined> {
    switch (cmd.execute_on) {
      case "lxc": {
        const execStrLxc = this.variableResolver.replaceVars(rawStr);
        const vm_id = this.getVmId();
        if (!vm_id) {
          const msg = "vm_id is required for LXC execution but was not found in inputs or outputs.";
          this.messageEmitter.emitStandardMessage(cmd, msg, null, -1, -1);
          throw new Error(msg);
        }
        await this.runOnLxc(vm_id, execStrLxc, cmd);
        return undefined;
      }
      case "ve": {
        const execStrVe = this.variableResolver.replaceVars(rawStr);
        return await this.runOnVeHost(execStrVe, cmd);
      }
      default: {
        if (typeof cmd.execute_on === "string" && /^host:.*/.test(cmd.execute_on)) {
          const hostname = (cmd.execute_on as string).split(":")[1] ?? "";
          // Pass raw (unreplaced) string; executeOnHost will replace with vmctx.data
          await this.executeOnHost(hostname, rawStr, cmd);
          return undefined;
        } else {
          throw new Error(cmd.name + " is missing the execute_on property");
        }
      }
    }
  }

  /**
   * Parses fallback outputs from echo JSON format.
   */
  private parseFallbackOutputs(lastMsg: IVeExecuteMessage | undefined): void {
    if (
      this.outputs.size === 0 &&
      lastMsg &&
      typeof lastMsg.result === "string"
    ) {
      const m = String(lastMsg.result)
        .replace(/^echo\s+/, "")
        .replace(/^"/, "")
        .replace(/"$/, "");
      try {
        const obj = JSON.parse(m);
        this.outputsRaw = [];
        for (const [name, value] of Object.entries(obj)) {
          const v = value as string | number | boolean;
          this.outputs.set(name, v);
          this.outputsRaw.push({ name, value: v });
        }
      } catch {
        // Ignore parse errors
      }
    }
  }

  /**
   * Builds restart info object from current state.
   */
  private buildRestartInfo(lastSuccessIndex: number): IRestartInfo {
    const vm_id = this.outputs.get("vm_id");
    return {
      vm_id:
        vm_id !== undefined
          ? Number.parseInt(vm_id as string, 10)
          : undefined,
      lastSuccessfull: lastSuccessIndex,
      inputs: Object.entries(this.inputs).map(([name, value]) => ({
        name,
        value,
      })),
      outputs:
        this.outputsRaw && Array.isArray(this.outputsRaw)
          ? this.outputsRaw.map(({ name, value }) => ({ name, value }))
          : Array.from(this.outputs.entries()).map(([name, value]) => ({
              name,
              value,
            })),
      defaults: Array.from(this.defaults.entries()).map(
        ([name, value]) => ({ name, value }),
      ),
    };
  }


  /**
   * Runs all commands, replacing variables from inputs/outputs, and executes them on the correct target.
   * Returns the index of the last successfully executed command.
   */
  async run(
    restartInfo: IRestartInfo | null = null,
  ): Promise<IRestartInfo | undefined> {
    let rcRestartInfo: IRestartInfo | undefined = undefined;
    let msgIndex = 0;
    const startIdx = this.restoreStateFromRestartInfo(restartInfo);
    outerloop: for (let i = startIdx; i < this.commands.length; ++i) {
      const cmd = this.commands[i];
      if (!cmd || typeof cmd !== "object") continue;
      
      // Check if this is a skipped command (has "(skipped)" in name)
      if (cmd.name && cmd.name.includes("(skipped)")) {
        msgIndex = this.handleSkippedCommand(cmd, msgIndex);
        continue;
      }
      
      try {
        if (cmd.properties !== undefined) {
          // Handle properties: replace variables in values, set as outputs
          msgIndex = this.handlePropertiesCommand(cmd, msgIndex);
          continue; // Skip execution, only set properties
        }
        
        // Load command content
        const rawStr = this.loadCommandContent(cmd);
        if (!rawStr) {
          continue; // Skip unknown command type
        }
        
        // Execute command based on target
        let lastMsg: IVeExecuteMessage | undefined;
        try {
          lastMsg = await this.executeCommandByTarget(cmd, rawStr);
        } catch (err: any) {
          // Handle execution errors
          if (typeof cmd.execute_on === "string" && /^host:.*/.test(cmd.execute_on)) {
            const hostname = (cmd.execute_on as string).split(":")[1] ?? "";
            this.messageEmitter.emitErrorMessage(cmd, err, msgIndex++, hostname);
          } else {
            this.messageEmitter.emitErrorMessage(cmd, err, msgIndex++);
          }
          // Only set restartInfo if we've executed at least one command successfully
          if (i > startIdx) {
            rcRestartInfo = this.buildRestartInfo(i - 1);
          }
          break outerloop;
        }

        // Fallback: if no outputs were produced, try to parse echo JSON
        this.parseFallbackOutputs(lastMsg);

        // Build restart info for successful execution
        rcRestartInfo = this.buildRestartInfo(i);
      } catch (e) {
        // Handle any other errors
        this.messageEmitter.emitErrorMessage(cmd, e, msgIndex++);
        // Set restartInfo even on error so restart is possible, but only if we've executed at least one command
        if (i > startIdx) {
          rcRestartInfo = this.buildRestartInfo(i - 1);
        }
        break outerloop;
      }
    }
    // Check if all commands completed successfully
    const allSuccessful =
      rcRestartInfo !== undefined &&
      rcRestartInfo.lastSuccessfull === this.commands.length - 1;

    if (allSuccessful) {
      // Send a final success message
      this.emit("message", {
        command: "Completed",
        execute_on: "ve",
        exitCode: 0,
        result: "All commands completed successfully",
        stderr: "",
        finished: true,
        partial: false,
      } as IVeExecuteMessage);

      if (restartInfo == undefined) {
        this.emit("finished", this.buildVmContext());
      }
    }
    return rcRestartInfo;
  }

  buildVmContext(): IVMContext {
    if (!this.veContext) {
      throw new Error("VE context not set");
    }
    var data: any = {};
    data.vmid = this.outputs.get("vm_id");
    const hostVal = (this.veContext as any)?.host;
    const veKey =
      typeof (this.veContext as any)?.getKey === "function"
        ? (this.veContext as any).getKey()
        : typeof hostVal === "string"
          ? `ve_${hostVal}`
          : undefined;
    data.vekey = veKey;
    data.data = {};

    this.outputs.forEach((value, key) => {
      data.data[key] = value;
    });
    return new VMContext(data);
  }

  /**
   * Replaces {{var}} in a string with values from inputs or outputs.
   * @internal For backward compatibility and testing
   */
  private replaceVars(str: string): string {
    return this.variableResolver.replaceVars(str);
  }

  /**
   * Replace variables using a provided context map first (e.g., vmctx.data),
   * then fall back to outputs, inputs, and defaults.
   * @internal For backward compatibility
   */
  protected replaceVarsWithContext(
    str: string,
    ctx: Record<string, any>,
  ): string {
    return this.variableResolver.replaceVarsWithContext(str, ctx);
  }
}
