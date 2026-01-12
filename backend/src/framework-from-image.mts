import { IFramework } from "./types.mjs";
import { IVEContext } from "./backend-types.mjs";
import { IOciImageAnnotations } from "./types.mjs";
import { ExecutionMode, determineExecutionMode } from "./ve-execution-constants.mjs";
import { VeExecutionSshExecutor, SshExecutorDependencies } from "./ve-execution-ssh-executor.mjs";
import { VeExecutionMessageEmitter } from "./ve-execution-message-emitter.mjs";
import { OutputProcessor } from "./output-processor.mjs";
import { spawnAsync } from "./spawn-utils.mjs";
import { EventEmitter } from "events";
import path from "path";
import { PersistenceManager } from "./persistence/persistence-manager.mjs";

export class FrameworkFromImage {
  /**
   * Executes a script on the VE host to extract OCI image annotations.
   * 
   * @param veContext VE context for SSH connection
   * @param image OCI image name (e.g., mariadb, ghcr.io/home-assistant/home-assistant)
   * @param tag Image tag (default: latest)
   * @param executionMode Optional execution mode (defaults to auto-detect)
   * @returns Extracted annotations
   */
  static async getAnnotationsFromImage(
    veContext: IVEContext,
    image: string,
    tag: string = "latest",
    executionMode?: ExecutionMode,
  ): Promise<IOciImageAnnotations> {
    const scriptPath = this.getScriptPath();
    const mode = executionMode ?? determineExecutionMode();
    
    // Build command arguments
    const args = [image, "--tag", tag, "--platform", "linux/amd64"];
    
    // Execute via SSH or locally based on execution mode
    const annotations = await this.executeOnVeHost(veContext, scriptPath, args, mode);
    
    return annotations;
  }

  /**
   * Executes a script on the VE host via SSH or locally based on execution mode.
   * Uses VeExecutionSshExecutor for building execution args, but executes the script
   * as a file (not via stdin) using spawnAsync directly.
   */
  private static async executeOnVeHost(
    veContext: IVEContext,
    scriptPath: string,
    args: string[],
    executionMode: ExecutionMode,
  ): Promise<IOciImageAnnotations> {
    const interpreter = ["python3"];
    const timeoutMs = 60000; // 60 seconds
    
    // Create minimal dependencies for VeExecutionSshExecutor (only for buildExecutionArgs)
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);
    const outputs = new Map<string, string | number | boolean>();
    const defaults = new Map<string, string | number | boolean>();
    const outputProcessor = new OutputProcessor(outputs, undefined, defaults, executionMode);
    
    const deps: SshExecutorDependencies = {
      veContext: executionMode === ExecutionMode.PRODUCTION ? veContext : null,
      executionMode,
      scriptTimeoutMs: timeoutMs,
      messageEmitter,
      outputProcessor,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    };
    
    const sshExecutor = new VeExecutionSshExecutor(deps);
    
    // Build execution args (SSH args in production, interpreter args in test)
    const executionArgs = sshExecutor.buildExecutionArgs(interpreter);
    
    // For file-based execution, append script path and args to executionArgs
    // In PRODUCTION: executionArgs contains SSH args + interpreter, we append scriptPath + args
    // In TEST: executionArgs contains interpreter, we append scriptPath + args
    const fullArgs = [...executionArgs, scriptPath, ...args];
    
    // Determine actual command and args for spawnAsync
    let actualCommand: string;
    let actualArgs: string[];
    
    if (executionMode === ExecutionMode.PRODUCTION) {
      // Production: ssh with full args (SSH args + interpreter + scriptPath + args)
      actualCommand = "ssh";
      actualArgs = fullArgs;
    } else {
      // Test: python3 with scriptPath + args (executionArgs already contains python3)
      if (!interpreter[0]) {
        throw new Error("Interpreter is required for test mode");
      }
      actualCommand = interpreter[0];
      actualArgs = [scriptPath, ...args];
    }
    
    // Execute script as file (not via stdin)
    const result = await spawnAsync(actualCommand, actualArgs, {
      timeout: timeoutMs,
    });
    
    if (result.exitCode !== 0) {
      throw new Error(`Script failed with exit code ${result.exitCode}: ${result.stderr}`);
    }
    
    try {
      const annotations = JSON.parse(result.stdout) as IOciImageAnnotations;
      return annotations;
    } catch (e) {
      throw new Error(`Failed to parse JSON output: ${e}. Output: ${result.stdout}`);
    }
  }

  /**
   * Gets the path to the get-oci-image-annotations.py script.
   * Uses jsonPath from PersistenceManager, which can be configured during initialization.
   */
  private static getScriptPath(): string {
    const jsonPath = PersistenceManager.getInstance().getPathes().jsonPath;
    const scriptPath = path.join(
      jsonPath,
      "shared/scripts/get-oci-image-annotations.py",
    );
    return scriptPath;
  }

  /**
   * Builds a pre-filled Framework object from OCI image annotations.
   * 
   * @param image OCI image name
   * @param annotations Extracted annotations from image
   * @param baseApplicationId Base application ID to extend (e.g., "npm-nodejs")
   * @returns Pre-filled Framework object
   */
  static buildFrameworkFromAnnotations(
    image: string,
    annotations: IOciImageAnnotations,
    baseApplicationId: string = "npm-nodejs",
  ): Partial<IFramework> {
    // Extract image name for framework name
    const imageName = image.split("/").pop()?.split(":")[0] || image;
    const frameworkName = imageName
      .split("-")
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    
    const framework: Partial<IFramework> = {
      name: frameworkName,
      extends: baseApplicationId,
      properties: [], // Will be filled by framework loader
      ...(annotations.url && { url: annotations.url }),
      ...(annotations.documentation && { documentation: annotations.documentation }),
      ...(annotations.source && { source: annotations.source }),
      ...(annotations.vendor && { vendor: annotations.vendor }),
      ...(annotations.description && { description: annotations.description }),
    };
    
    return framework;
  }
}

