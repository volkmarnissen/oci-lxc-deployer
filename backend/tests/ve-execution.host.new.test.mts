// TESTING STRATEGY FOR execute_on: "host:hostname"
//
// We test the logic, not the external dependencies.
// External dependencies (SSH, LXC) are executed locally via sshCommand="sh".
//
// IMPORTANT: sshCommand is set to "sh" to avoid SSH calls.
// runOnVeHost and runOnLxc will then automatically execute locally (see buildSshArgs and runOnLxc).
// remoteCommand is automatically set by runOnLxc when sshCommand !== "ssh".

import { describe, it, expect, beforeEach } from "vitest";
import { VeExecution } from "@src/ve-execution.mjs";
import { ICommand } from "@src/types.mjs";
import { StorageContext } from "@src/storagecontext.mjs";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
describe("VeExecution host: flow (new)", () => {

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
   */
  function setupVEContext(): void {
    const storage = StorageContext.getInstance();
    storage.setVEContext({
      host: "localhost",
      port: 22,
      getStorageContext: () => storage,
      getKey: () => "ve_localhost",
    });
  }

  /**
   * Helper function to set up VM context with default values.
   */
  function setupVMContext(
    vmid: number,
    vekey: string,
    outputs: Record<string, string| number| boolean>,
  ): void {
    const storage = StorageContext.getInstance();
    storage.setVMContext({
      vmid,
      vekey,
      outputs,
      getKey: () => `vm_${vmid}`,
    });
  }

  /**
   * Test case 1: Single command with execute_on: "host:hostname"
   * 
   * NOTE: A single command with execute_on: "host:hostname" is treated as a template
   * and calls executeTemplateOnHost, not executeOnHost.
   * 
   * TO TEST:
   * - executeTemplateOnHost is called
   * - Command is executed on LXC (via runOnLxc with remoteCommand)
   * - sshCommand="sh" leads to local execution without SSH
   */
  it("executes command on LXC via executeTemplateOnHost", async () => {
    setupVEContext();
    setupVMContext(101, "ve_localhost", { hostname: "apphost", pve: "pve-1" });
    
    const command: ICommand = {
      name: "deploy",
      command: "echo 'hello'",
      execute_on: "host:apphost",
    };

    // Create VeExecution with "sh" instead of "ssh"
    // runOnVeHost and runOnLxc will then automatically execute locally
    // remoteCommand is automatically set by runOnLxc when sshCommand !== "ssh"
    const veContext = StorageContext.getInstance().getVEContextByKey("ve_localhost");
    if (!veContext) {
      throw new Error("VE context not found for key: ve_localhost");
    }
    const exec = new VeExecution([command], [{id:"vm_id", value: 101}], veContext, undefined, "sh");

    const rc = await exec.run();

    // Assertions
    expect(rc?.lastSuccessfull).toBe(0);
  });
});
