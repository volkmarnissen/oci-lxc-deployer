import { ICommand } from "./types.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { VeExecutionConstants } from "./ve-execution-constants.mjs";
import { VeExecutionSshExecutor, SshExecutorDependencies } from "./ve-execution-ssh-executor.mjs";

export interface HostDiscoveryDependencies {
  sshExecutor: VeExecutionSshExecutor;
  outputs: Map<string, string | number | boolean>;
  variableResolver: {
    replaceVarsWithContext: (str: string, ctx: Record<string, any>) => string;
  };
  runOnLxc: (vm_id: string | number, command: string, tmplCommand: ICommand) => Promise<any>;
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
      vmctx?.data?.pve !== undefined && vmctx.data.pve === found.pve;
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
    
    // Replace variables with vmctx.data for host execution, then with outputs
    const execCmd = this.deps.variableResolver.replaceVarsWithContext(
      this.deps.variableResolver.replaceVarsWithContext(
        command,
        (vmctx as any).data || {},
      ),
      Object.fromEntries(this.deps.outputs) || {},
    );
    await this.deps.runOnLxc(vmctx.vmid, execCmd, tmplCommand);
  }
}

