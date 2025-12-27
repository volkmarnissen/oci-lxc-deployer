import { EventEmitter } from "events";
import { ICommand, IVeExecuteMessage } from "./types.mjs";
import { IVEContext, IVMContext } from "./backend-types.mjs";
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
import { VeExecutionCommandProcessor } from "./ve-execution-command-processor.mjs";
import { VeExecutionStateManager } from "./ve-execution-state-manager.mjs";

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
  private commandProcessor!: VeExecutionCommandProcessor;
  private stateManager: VeExecutionStateManager;
  
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
    this.stateManager = new VeExecutionStateManager({
      outputs: this.outputs,
      outputsRaw: this.outputsRaw,
      inputs: this.inputs,
      defaults: this.defaults,
      veContext: this.veContext,
      initializeVariableResolver: () => this.initializeVariableResolver(),
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
   * Updates helper modules with current state (called when state might have changed).
   */
  private updateHelperModules(): void {
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
    this.commandProcessor = new VeExecutionCommandProcessor({
      outputs: this.outputs,
      inputs: this.inputs,
      variableResolver: this.variableResolver,
      messageEmitter: this.messageEmitter,
      runOnLxc: (vm_id, cmd, tmplCmd) => this.runOnLxc(vm_id, cmd, tmplCmd),
      runOnVeHost: (input, cmd, timeout, remote) => this.runOnVeHost(input, cmd, timeout, remote),
      executeOnHost: (hostname, cmd, tmplCmd) => this.executeOnHost(hostname, cmd, tmplCmd),
      outputsRaw: this.outputsRaw,
      setOutputsRaw: (raw) => {
        this.outputsRaw = raw;
      },
    });
    this.stateManager = new VeExecutionStateManager({
      outputs: this.outputs,
      outputsRaw: this.outputsRaw,
      inputs: this.inputs,
      defaults: this.defaults,
      veContext: this.veContext,
      initializeVariableResolver: () => this.initializeVariableResolver(),
    });
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
    this.updateHelperModules();
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
    // Update helper modules in case state changed
    this.updateHelperModules();
    return await this.hostDiscovery.executeOnHost(hostname, command, tmplCommand, this);
  }





  /**
   * Runs all commands, replacing variables from inputs/outputs, and executes them on the correct target.
   * Returns the index of the last successfully executed command.
   */
  async run(
    restartInfo: IRestartInfo | null = null,
  ): Promise<IRestartInfo | undefined> {
    // Update all helper modules with current state
    this.updateHelperModules();
    
    let rcRestartInfo: IRestartInfo | undefined = undefined;
    let msgIndex = 0;
    const startIdx = this.stateManager.restoreStateFromRestartInfo(restartInfo);
    outerloop: for (let i = startIdx; i < this.commands.length; ++i) {
      const cmd = this.commands[i];
      if (!cmd || typeof cmd !== "object") continue;
      
      // Update helper modules in case state changed during execution
      this.updateHelperModules();

      // Check if this is a skipped command (has "(skipped)" in name)
      if (cmd.name && cmd.name.includes("(skipped)")) {
        msgIndex = this.commandProcessor.handleSkippedCommand(cmd, msgIndex);
        continue;
      }
      
      try {
        if (cmd.properties !== undefined) {
          // Handle properties: replace variables in values, set as outputs
          msgIndex = this.commandProcessor.handlePropertiesCommand(cmd, msgIndex);
          continue; // Skip execution, only set properties
        }
        
        // Load command content
        const rawStr = this.commandProcessor.loadCommandContent(cmd);
        if (!rawStr) {
          continue; // Skip unknown command type
        }
        
        // Execute command based on target
        let lastMsg: IVeExecuteMessage | undefined;
        try {
          lastMsg = await this.commandProcessor.executeCommandByTarget(cmd, rawStr);
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
            rcRestartInfo = this.stateManager.buildRestartInfo(i - 1);
          }
          break outerloop;
        }

        // Fallback: if no outputs were produced, try to parse echo JSON
        this.commandProcessor.parseFallbackOutputs(lastMsg);

        // Build restart info for successful execution
        rcRestartInfo = this.stateManager.buildRestartInfo(i);
      } catch (e) {
        // Handle any other errors
        this.messageEmitter.emitErrorMessage(cmd, e, msgIndex++);
        // Set restartInfo even on error so restart is possible, but only if we've executed at least one command
        if (i > startIdx) {
          rcRestartInfo = this.stateManager.buildRestartInfo(i - 1);
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
    // Update helper modules in case state changed
    this.updateHelperModules();
    return this.stateManager.buildVmContext();
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
