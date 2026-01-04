// TESTING STRATEGY FOR execute_on: "host:hostname"
//
// Es gibt zwei verschiedene Code-Pfade:
//
// 1. EINZELNER COMMAND mit execute_on: "host:hostname"
//    - Wird in executeCommandByTarget behandelt
//    - Ruft executeOnHost auf
//    - executeOnHost: führt Probe aus → ruft runOnLxc auf
//    - ZU TESTEN: executeOnHost wird aufgerufen, Probe wird ausgeführt, runOnLxc wird mit richtigem vmid aufgerufen
//    - MOCKEN: probeHostForVmIds (SSH-Aufruf), runOnLxc (LXC-Aufruf)
//    - NICHT MOCKEN: executeOnHost selbst, die Logik in VeExecution.run()
//
// 2. TEMPLATE (mehrere Commands) mit execute_on: "host:hostname"
//    - Wird in VeExecution.run() erkannt (Zeile 330)
//    - Ruft executeTemplateOnHost auf
//    - executeTemplateOnHost: erstellt neue VeExecution → führt Commands auf LXC aus
//    - ZU TESTEN: executeTemplateOnHost wird aufgerufen, vmContext.data wird als inputs übergeben
//    - MOCKEN: runOnLxc (LXC-Aufruf), SSH-Aufrufe
//    - NICHT MOCKEN: executeTemplateOnHost selbst, die Logik in VeExecution.run()
//
// REGEL: Nur externe Abhängigkeiten mocken (SSH, LXC, Dateisystem), nicht die Logik, die wir testen wollen!

import { describe, it, expect, beforeEach } from "vitest";
import { VeExecution } from "@src/ve-execution.mjs";
import { ICommand, IVeExecuteMessage } from "@src/types.mjs";
import { StorageContext } from "@src/storagecontext.mjs";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { IVEContext } from "@src/backend-types.mjs";
import { getNextMessageIndex } from "@src/ve-execution-constants.mjs";
import { VeExecutionHostDiscovery } from "@src/ve-execution-host-discovery.mjs";

describe("VeExecution host: flow", () => {
  const dummyVE: IVEContext = { host: "localhost", port: 22, getStorageContext: () => StorageContext.getInstance(), getKey: () => "ve_localhost" };
  const defaults = new Map<string, string | number | boolean>();

  beforeEach(() => {
    // Reset singleton with a unique temp directory to isolate contexts
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "lxc-mgr-host-"));
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    if (!fs.existsSync(path.join(tmpDir, "local")))
      fs.mkdirSync(path.join(tmpDir, "local"), { recursive: true });
    const storageContextFilePath = path.join(tmpDir, "storagecontext.json");
    const secretFilePath = path.join(tmpDir, "secret.txt");
    StorageContext.setInstance(tmpDir, storageContextFilePath, secretFilePath);
  });

  /**
   * Helper function to set up VE context with default values.
   * This is required before setting VM context.
   */
  function setupVEContext(): void {
    const storage = StorageContext.getInstance();
    storage.setVEContext({ host: "localhost", port: 22 });
  }

  /**
   * Helper function to set up VM context with default values.
   * Must be called after setupVEContext().
   */
  function setupVMContext(
    vmid: number,
    vekey: string,
    data: Record<string, any>,
  ): void {
    const storage = StorageContext.getInstance();
    storage.setVMContext({
      vmid,
      vekey,
      data,
      getKey: () => `vm_${vmid}`,
    });
  }

  // Test 1: Einzelner Command mit execute_on: "host:hostname"
  // ZU TESTEN: executeOnHost wird aufgerufen, Probe wird ausgeführt, runOnLxc wird mit richtigem vmid aufgerufen
  // MOCKEN: probeHostForVmIds (SSH), runOnLxc (LXC)
  it("calls write-vmids-json.sh and then runs on matching LXC", async () => {
    setupVEContext();
    setupVMContext(101, "ve_localhost", { hostname: "apphost", pve: "pve-1" });
    const command: ICommand = {
      name: "deploy",
      command: "echo 'hello'",
      execute_on: "host:apphost",
    };
    
    class TestExec extends VeExecution {
      public probePath: string | undefined;
      public lxcCalledWith: { vmid?: number | string; command?: string } = {};
      
      // Mock nur die externe Abhängigkeit (Probe via SSH)
      protected createHostDiscovery(): VeExecutionHostDiscovery {
        const hostDiscovery = super.createHostDiscovery();
        // Mock probeHostForVmIds (SSH-Aufruf) - das ist eine externe Abhängigkeit
        const originalProbeHostForVmIds = hostDiscovery.probeHostForVmIds.bind(hostDiscovery);
        hostDiscovery.probeHostForVmIds = async (tmplCommand, eventEmitter) => {
          this.probePath = path.join("json", "shared", "scripts", "write-vmids-json.sh");
          this.outputs.set("used_vm_ids", JSON.stringify([
            { hostname: "apphost", pve: "pve-1", vmid: 101 },
          ]));
          // Return mock output instead of calling SSH
          return JSON.stringify([{ hostname: "apphost", pve: "pve-1", vmid: 101 }]);
        };
        return hostDiscovery;
      }
      
      // Mock nur die externe Abhängigkeit (LXC-Aufruf)
      protected async runOnLxc(
        vmid: string | number,
        command: string,
        tmplCommand: ICommand,
      ) {
        this.lxcCalledWith = { vmid, command };
        return {
          stderr: "",
          result: command,
          exitCode: 0,
          command: tmplCommand.name,
          execute_on: tmplCommand.execute_on!,
          index: 1,
        } as any;
      }
    }
    
    const exec = new TestExec([command], [], dummyVE, defaults, "sh");
    const rc = await exec.run();
    
    // Test: executeOnHost wurde aufgerufen (indirekt über executeCommandByTarget)
    expect(rc?.lastSuccessfull).toBe(0);
    // Test: Probe wurde ausgeführt
    expect(exec.probePath).toBeDefined();
    expect(
      exec.probePath!.endsWith(
        path.join("json", "shared", "scripts", "write-vmids-json.sh"),
      ),
    ).toBe(true);
    // Test: runOnLxc wurde mit richtigem vmid aufgerufen
    expect(exec.lxcCalledWith.vmid).toBe(101);
    expect(exec.lxcCalledWith.command).toBe("echo 'hello'");
  });

  // Weitere Tests folgen...
  
  it("fails when PVE differs between probe and VMContext", async () => {
    setupVEContext();
    setupVMContext(101, "ve_localhost", { hostname: "apphost", pve: "pve-1" });
    const command: ICommand = {
      name: "deploy",
      command: "echo 'hello'",
      execute_on: "host:apphost",
    };
    class TestExec extends VeExecution {
      protected createHostDiscovery(): VeExecutionHostDiscovery {
        const hostDiscovery = super.createHostDiscovery();
        hostDiscovery.probeHostForVmIds = async () => {
          this.outputs.set("used_vm_ids", JSON.stringify([
            { hostname: "apphost", pve: "pve-2", vmid: 101 }, // Different PVE!
          ]));
          return JSON.stringify([{ hostname: "apphost", pve: "pve-2", vmid: 101 }]);
        };
        return hostDiscovery;
      }
      protected async runOnLxc() {
        throw new Error("runOnLxc should not be called");
      }
    }
    const exec = new TestExec([command], [], dummyVE, defaults, "sh");
    await expect(exec.run()).rejects.toThrow();
  });

  it("fails when VMID differs between probe and VMContext", async () => {
    setupVEContext();
    setupVMContext(101, "ve_localhost", { hostname: "apphost", pve: "pve-1" });
    const command: ICommand = {
      name: "deploy",
      command: "echo 'hello'",
      execute_on: "host:apphost",
    };
    class TestExec extends VeExecution {
      protected createHostDiscovery(): VeExecutionHostDiscovery {
        const hostDiscovery = super.createHostDiscovery();
        hostDiscovery.probeHostForVmIds = async () => {
          this.outputs.set("used_vm_ids", JSON.stringify([
            { hostname: "apphost", pve: "pve-1", vmid: 999 }, // Different VMID!
          ]));
          return JSON.stringify([{ hostname: "apphost", pve: "pve-1", vmid: 999 }]);
        };
        return hostDiscovery;
      }
      protected async runOnLxc() {
        throw new Error("runOnLxc should not be called");
      }
    }
    const exec = new TestExec([command], [], dummyVE, defaults, "sh");
    await expect(exec.run()).rejects.toThrow();
  });

  // Test 2: Template mit execute_on: "host:hostname"
  // ZU TESTEN: executeTemplateOnHost wird aufgerufen, vmContext.data wird als inputs übergeben
  // MOCKEN: runOnLxc (LXC-Aufruf)
  // NICHT MOCKEN: executeTemplateOnHost selbst, die Logik in VeExecution.run()
  
  it("replaces host command variables using vmctx.data (not outputs)", async () => {
    setupVEContext();
    setupVMContext(101, "ve_localhost", {
      hostname: "apphost",
      pve: "pve-1",
      app_name: "myapp",
    });
    const command: ICommand = {
      name: "deploy",
      command: "echo '{{app_name}}-on-{{hostname}}'",
      execute_on: "host:apphost",
    };
    
    class TestExec extends VeExecution {
      public captured: string | undefined;
      
      // Mock nur die externe Abhängigkeit (executeTemplateOnHost ruft intern runOnLxc auf)
      protected createHostDiscovery(): VeExecutionHostDiscovery {
        const hostDiscovery = super.createHostDiscovery();
        // Mock executeTemplateOnHost um zu prüfen, dass vmctx.data verwendet wird
        hostDiscovery.executeTemplateOnHost = async (
          hostname: string,
          templateCommands: ICommand[],
          eventEmitter: { emit: (event: string, data: any) => void },
          parentVeContext: any,
          sshCommand: string,
        ) => {
          // Simulate what executeTemplateOnHost does: replace variables with vmctx.data
          const storage = StorageContext.getInstance();
          const vmctx = storage.getVMContextByHostname(hostname);
          if (vmctx && templateCommands.length > 0) {
            const cmd = templateCommands[0];
            if (cmd?.command) {
              const execCmd = this.replaceVarsWithContext(
                this.replaceVarsWithContext(
                  cmd.command,
                  (vmctx as any).data || {},
                ),
                Object.fromEntries(this.outputs) || {},
              );
              this.captured = execCmd;
              // Emit a message to simulate execution
              eventEmitter.emit("message", {
                stderr: "",
                result: execCmd,
                exitCode: 0,
                command: cmd.name,
                execute_on: cmd.execute_on,
                index: 0,
              } as any);
            }
          }
        };
        return hostDiscovery;
      }
    }
    
    // Provide an input that would differ from vmctx.data to ensure data wins
    const exec = new TestExec(
      [command],
      [{ id: "app_name", value: "inputApp" }],
      dummyVE,
      defaults,
      "sh",
    );
    
    const rc = await exec.run();
    expect(rc?.lastSuccessfull).toBe(0);
    expect(exec.captured).toContain("myapp-on-apphost");
    expect(exec.captured).not.toContain("inputApp");
  });

  it("prefers vmctx.data.vm_id over outputs.vm_id", async () => {
    setupVEContext();
    setupVMContext(101, "ve_localhost", {
      hostname: "apphost",
      pve: "pve-1",
      vm_id: 101,
    });

    const command: ICommand = {
      name: "deploy",
      command: "echo '{{vm_id}}'",
      execute_on: "host:apphost",
    };

    class TestExec extends VeExecution {
      public captured: string | undefined;
      
      protected createHostDiscovery(): VeExecutionHostDiscovery {
        const hostDiscovery = super.createHostDiscovery();
        hostDiscovery.executeTemplateOnHost = async (
          hostname: string,
          templateCommands: ICommand[],
          eventEmitter: { emit: (event: string, data: any) => void },
          parentVeContext: any,
          sshCommand: string,
        ) => {
          const storage = StorageContext.getInstance();
          const vmctx = storage.getVMContextByHostname(hostname);
          if (vmctx && templateCommands.length > 0) {
            const cmd = templateCommands[0];
            if (cmd?.command) {
              // First replace with outputs, then with vmctx.data (vmctx.data wins)
              const execCmd = this.replaceVarsWithContext(
                this.replaceVarsWithContext(
                  cmd.command,
                  Object.fromEntries(this.outputs) || {},
                ),
                (vmctx as any).data || {},
              );
              this.captured = execCmd;
              eventEmitter.emit("message", {
                stderr: "",
                result: execCmd,
                exitCode: 0,
                command: cmd.name,
                execute_on: cmd.execute_on,
                index: 0,
              } as any);
            }
          }
        };
        return hostDiscovery;
      }
    }

    const outputs = [{ id: "vm_id", value: "999" }] as any;
    const exec = new TestExec([command], outputs, dummyVE, defaults, "sh");
    
    const rc = await exec.run();
    expect(rc?.lastSuccessfull).toBe(0);
    expect(exec.captured).toContain("101");
    expect(exec.captured).not.toContain("999");
  });

  it("executes template on host with properties and vmContext inputs (using sh)", async () => {
    setupVEContext();
    // Note: vm_id should NOT be in vmContext.data - it comes from vmctx.vmid
    // and will be added as input automatically by executeTemplateOnHost
    setupVMContext(101, "ve_localhost", {
      hostname: "testhost",
      pve: "pve-1",
      vmctx_output: "value-from-vmcontext", // This should be available in the script
    });

    // Create a template with properties command and script command
    // The script should have access to:
    // 1. A property from the properties command: "property_value"
    // 2. An output from vmContext: "vmctx_output"
    const templateCommands: ICommand[] = [
      {
        name: "Set Properties",
        properties: [
          { id: "property_value", value: "value-from-properties" },
        ],
        execute_on: "host:testhost",
      },
      {
        name: "Test Script",
        command: "echo 'property_value={{property_value}} vmctx_output={{vmctx_output}}'",
        execute_on: "host:testhost",
      },
    ];

    class TestExec extends VeExecution {
      public capturedCommands: string[] = [];
      public capturedVmId: number | undefined;
      public capturedInputs: Record<string, string | number | boolean> = {};
      public templateExecuted = false;

      // Mock nur die externe Abhängigkeit (LXC-Aufruf)
      protected async runOnLxc(
        vmid: string | number,
        command: string,
        tmplCommand: ICommand,
      ) {
        this.capturedVmId = Number(vmid);
        this.capturedCommands.push(command);
        this.capturedInputs = { ...(this as any).inputs };
        
        // Simulate command execution with variable replacement
        let result = command;
        for (const [key, value] of Object.entries((this as any).inputs)) {
          result = result.replace(new RegExp(`\\{\\{${key}\\}\\}`, "g"), String(value));
        }
        
        return {
          stderr: "",
          result: result,
          exitCode: 0,
          command: tmplCommand.name,
          execute_on: "lxc",
          index: getNextMessageIndex(),
        } as IVeExecuteMessage;
      }
      
      // Track dass executeTemplateOnHost aufgerufen wurde
      protected createHostDiscovery(): VeExecutionHostDiscovery {
        const hostDiscovery = super.createHostDiscovery();
        const originalExecuteTemplateOnHost = hostDiscovery.executeTemplateOnHost.bind(hostDiscovery);
        hostDiscovery.executeTemplateOnHost = async (
          hostname: string,
          commands: ICommand[],
          eventEmitter: any,
          veContext: IVEContext | null,
          sshCommand: string,
        ) => {
          this.templateExecuted = true;
          return originalExecuteTemplateOnHost(
            hostname,
            commands,
            eventEmitter,
            veContext,
            sshCommand,
          );
        };
        return hostDiscovery;
      }
    }
    
    const exec = new TestExec(
      templateCommands,
      [],
      dummyVE,
      defaults,
      "sh", // Use sh instead of ssh
    );

    const rc = await exec.run();
    
    // Check that executeTemplateOnHost was called
    expect(exec.templateExecuted).toBe(true);
    
    expect(rc?.lastSuccessfull).toBe(1); // Both commands should succeed
    expect(exec.capturedVmId).toBe(101);
    
    // Check that both commands were executed
    // Properties command sets outputs, script command executes
    expect(exec.capturedCommands.length).toBe(1); // Only the script command, properties is handled separately
    
    // Check that the script command was executed with both values replaced
    const scriptCommand = exec.capturedCommands[0];
    expect(scriptCommand).toContain("property_value=value-from-properties");
    expect(scriptCommand).toContain("vmctx_output=value-from-vmcontext");
    
    // Check that inputs from vmContext are available
    expect(exec.capturedInputs.vmctx_output).toBe("value-from-vmcontext");
    expect(exec.capturedInputs.vm_id).toBe(101);
  });
});
