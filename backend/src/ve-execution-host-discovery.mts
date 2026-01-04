import { ICommand, IVeExecuteMessage } from "./types.mjs";
import { StorageContext, VMContext } from "./storagecontext.mjs";
import { VeExecutionConstants } from "./ve-execution-constants.mjs";
import { VeExecutionSshExecutor } from "./ve-execution-ssh-executor.mjs";
import { VeExecution } from "./ve-execution.mjs";
import { IVEContext, IVMContext } from "./backend-types.mjs";

export interface HostDiscoveryDependencies {
  sshExecutor: VeExecutionSshExecutor;
  outputs: Map<string, string | number | boolean>;
  variableResolver: {
    replaceVarsWithContext: (str: string, ctx: Record<string, any>) => string;
  };
  runOnLxc: (vm_id: string | number, command: string, tmplCommand: ICommand, timeoutMs?: number, remoteCommand?: string[]) => Promise<any>;
}

/**
 * Handles host discovery flow for VeExecution.
 */
export class VeExecutionHostDiscovery {
  constructor(private deps: HostDiscoveryDependencies) {}

  /**
   * Gets the path to the write-vmids-json.sh script.
   */
  private getWriteVmIdsScriptPath(): string {
    const { join, dirname } = require("node:path");
    const { fileURLToPath } = require("node:url");
    const here = dirname(fileURLToPath(import.meta.url));
    return join(here, "..", "json", "shared", "scripts", "write-vmids-json.sh");
  }

  /**
   * Probes the host for used VM IDs.
   */
  private async probeHostForVmIds(
    tmplCommand: ICommand,
    eventEmitter: { emit: (event: string, data: any) => void },
  ): Promise<string> {
    const scriptPath = this.getWriteVmIdsScriptPath();
    const probeMsg = await this.deps.sshExecutor.runOnVeHost(
      "",
      { ...tmplCommand, name: "write-vmids" } as any,
      VeExecutionConstants.HOST_PROBE_TIMEOUT_MS,
      [scriptPath],
      eventEmitter,
    );
    
    // Prefer parsed outputsRaw (name/value) if available
    let usedStr: string | undefined = undefined;
    if (this.deps.outputs.has("used_vm_ids")) {
      usedStr = String(this.deps.outputs.get("used_vm_ids"));
    }
    if (!usedStr && typeof probeMsg.result === "string") {
      usedStr = probeMsg.result as string;
    }
    if (!usedStr) {
      throw new Error("No used_vm_ids result received from host probe");
    }
    return usedStr;
  }

  /**
   * Parses and validates used_vm_ids JSON.
   */
  private parseAndValidateVmIds(usedStr: string): any[] {
    let arr: any;
    try {
      arr = JSON.parse(usedStr);
    } catch {
      throw new Error("Invalid used_vm_ids JSON");
    }
    if (!Array.isArray(arr)) {
      throw new Error("used_vm_ids is not an array");
    }
    return arr;
  }

  /**
   * Finds hostname in used_vm_ids array.
   */
  private findHostnameInVmIds(arr: any[], hostname: string): any {
    const found = arr.find(
      (x: any) => typeof x?.hostname === "string" && x.hostname === hostname,
    );
    if (!found) {
      throw new Error(`Hostname ${hostname} not found in used_vm_ids`);
    }
    return found;
  }

  /**
   * Validates that VMContext matches the found host data.
   */
  private validateHostMatch(vmctx: any, found: any): void {
    const pveOk =
      vmctx?.data?.pve !== undefined && vmctx.outputs.pve === found.pve;
    const vmidOk = Number(vmctx.vmid) === Number(found.vmid);
    if (!pveOk || !vmidOk) {
      throw new Error("PVE or VMID mismatch between host data and VMContext");
    }
  }

  /**
   * Executes host discovery flow: calls write-vmids-json.sh on VE host, parses used_vm_ids,
   * resolves VMContext by hostname, validates pve and vmid, then runs the provided command inside LXC.
   */
  async executeOnHost(
    hostname: string,
    command: string,
    tmplCommand: ICommand,
    eventEmitter: { emit: (event: string, data: any) => void },
  ): Promise<void> {
    // Probe host for VM IDs
    const usedStr = await this.probeHostForVmIds(tmplCommand, eventEmitter);
    
    // Parse and validate
    const arr = this.parseAndValidateVmIds(usedStr);
    const found = this.findHostnameInVmIds(arr, hostname);
    
    // Get and validate VMContext
    const storage = StorageContext.getInstance();
    const vmctx = storage.getVMContextByHostname(hostname);
    if (!vmctx) {
      throw new Error(`VMContext for ${hostname} not found`);
    }
    this.validateHostMatch(vmctx, found);
    
    // Replace variables with vmctx.outputs for host execution, then with outputs
    const execCmd = this.deps.variableResolver.replaceVarsWithContext(
      this.deps.variableResolver.replaceVarsWithContext(
        command,
        vmctx.outputs || {},
      ),
      Object.fromEntries(this.deps.outputs) || {},
    );
    // Use remoteCommand trick: if sshCommand !== "ssh", pass undefined to execute locally
    // This is handled by the runOnLxc implementation, but we need to pass it through
    // The runOnLxc function will determine remoteCommand based on sshCommand
    await this.deps.runOnLxc(vmctx.vmid, execCmd, tmplCommand);
  }

  /**
   * Executes a template on a host by creating a separate VeExecution instance.
   * The template receives outputs and defaults from vmContext.outputs as inputs.
   * Commands are executed directly on the LXC container (like executeOnLxc/lxc-attach).
   * @param hostname The hostname to execute the template on
   * @param templateCommands The commands of the template to execute
   * @param eventEmitter Event emitter for messages
   * @param parentVeContext The parent VE context (for SSH connection)
   * @param sshCommand SSH command to use
   */
  async executeTemplateOnHost(
    hostname: string,
    templateCommands: ICommand[],
    eventEmitter: { emit: (event: string, data: any) => void },
    parentVeContext: IVEContext | null,
    sshCommand: string = "ssh",
  ): Promise<void> {
    // Get and validate VMContext
    const storage = StorageContext.getInstance();
    const vmctx = storage.getVMContextByHostname(hostname);
    if (!vmctx) {
      throw new Error(`VMContext for ${hostname} not found`);
    }

    // Get VE context from vmContext.vekey
    const veContext = storage.getVEContextByKey(vmctx.vekey);
    if (!veContext) {
      throw new Error(`VE context not found for key: ${vmctx.vekey}`);
    }

    // Prepare inputs from vmContext.outputs (outputs and defaults)
    const vmData = vmctx.outputs || {};
    const inputs: Array<{ id: string; value: string | number | boolean }> = [];
    const defaults = new Map<string, string | number | boolean>();

    // Extract all values from vmContext.outputs as inputs
    // Note: vm_id from vmctx.vmid will be added separately if not already in data
    for (const [key, value] of Object.entries(vmData)) {
      if (value !== null && value !== undefined) {
        const val = typeof value === "object" ? JSON.stringify(value) : value;
        if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
          inputs.push({ id: key, value: val });
          defaults.set(key, val);
        }
      }
    }

    // Add vm_id from vmContext.vmid so runOnLxc can find it
    // Only add if not already present in vmctx.outputs
    if (!vmctx.outputs.hasOwnProperty("vm_id")) {
      inputs.push({ id: "vm_id", value: vmctx.vmid });
      defaults.set("vm_id", vmctx.vmid);
    }

    // Modify template commands to execute on LXC instead of host
    // All commands should run on the LXC container (vmctx.vmid)
    // Note: Properties commands don't need execute_on, they're handled separately
    const lxcCommands: ICommand[] = templateCommands.map((cmd) => {
      if (cmd.properties !== undefined) {
        // Properties commands don't need execute_on, they're handled in VeExecution
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { execute_on: _execute_on, ...cmdWithoutExecuteOn } = cmd;
        return cmdWithoutExecuteOn;
      }
      cmd.execute_on = "lxc";
      return cmd;
    });

    // Create a new VeExecution instance for the template
    // This will execute commands directly on the LXC container via lxc-attach
    // When sshCommand !== "ssh", runOnLxc will use the same trick as in VeExecution.runOnLxc
    // (lxcCmd = undefined, so runOnVeHost executes locally via buildSshArgs)
    // The new VeExecution instance will automatically use local execution when sshCommand="sh"
    // We override runOnLxc to use the parent's runOnLxc function from deps, which already
    // handles the sshCommand !== "ssh" case by setting lxcCmd = undefined
    // Define TemplateVeExecution inside the method to avoid circular import issues
    // Use a function to defer class definition until runtime when VeExecution is available
    const TemplateVeExecution = (function() {
      // VeExecution should be available at runtime when this function executes
      return class TemplateVeExecution extends VeExecution {
      constructor(
        commands: ICommand[],
        inputs: Array<{ id: string; value: string | number | boolean }>,
        veContext: IVEContext | null,
        defaults: Map<string, string | number | boolean>,
        sshCommand: string,
        private parentRunOnLxc: (vm_id: string | number, command: string, tmplCommand: ICommand, timeoutMs?: number, remoteCommand?: string[]) => Promise<any>,
      ) {
        super(commands, inputs, veContext, defaults, sshCommand);
      }
      
      protected async runOnLxc(
        vm_id: string | number,
        command: string,
        tmplCommand: ICommand,
        timeoutMs?: number,
        remoteCommand?: string[],
      ): Promise<IVeExecuteMessage> {
        // Use parent's runOnLxc function, which already handles sshCommand !== "ssh"
        // by setting lxcCmd = undefined, so runOnVeHost executes locally
        // Pass through remoteCommand to allow tests to override
        return await this.parentRunOnLxc(vm_id, command, tmplCommand, timeoutMs, remoteCommand);
      }
    };
    })();
    
    const templateExecution = new TemplateVeExecution(
      lxcCommands,
      inputs,
      veContext,
      defaults,
      sshCommand,
      this.deps.runOnLxc,
    );

    // Forward messages from template execution to parent event emitter
    templateExecution.on("message", (msg) => {
      eventEmitter.emit("message", msg);
    });

    // Capture finished event to save outputs back to VMContext
    templateExecution.on("finished", (updatedVMContext: IVMContext) => {
      // Merge outputs from template execution back into vmContext.outputs
      const updatedData = { ...vmctx.outputs, ...updatedVMContext.outputs };
      const mergedVMContext = new VMContext({
        vmid: vmctx.vmid,
        vekey: vmctx.vekey,
        outputs: updatedData,
        getKey: () => `vm_${vmctx.vmid}`,
      } as IVMContext);
      storage.setVMContext(mergedVMContext);
    });

    // Execute the template
    await templateExecution.run(null);
  }
}

