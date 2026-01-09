import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { VeExecutionCommandProcessor } from "@src/ve-execution-command-processor.mjs";
import { ICommand } from "@src/types.mjs";
import { VeExecutionMessageEmitter } from "@src/ve-execution-message-emitter.mjs";
import { VariableResolver } from "@src/variable-resolver.mjs";
import { EventEmitter } from "events";
import fs from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { IVEContext } from "@src/backend-types.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";

const dummyVE: IVEContext = { host: "localhost", port: 22 } as IVEContext;
let testDir: string;
let secretFilePath: string;

beforeAll(() => {
  // Create a temporary directory for the test
  testDir = mkdtempSync(path.join(os.tmpdir(), "ve-execution-command-processor-test-"));
  secretFilePath = path.join(testDir, "secret.txt");

  // Create a valid storagecontext.json file
  const storageContextPath = path.join(testDir, "storagecontext.json");
  fs.writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

  // Close existing instance if any
  try {
    PersistenceManager.getInstance().close();
  } catch {
    // Ignore if not initialized
  }
  PersistenceManager.initialize(testDir, storageContextPath, secretFilePath);
});

afterAll(() => {
  // Cleanup test directory
  try {
    if (testDir && fs.existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  } catch {
    // Ignore cleanup errors
  }
});

/**
 * Helper function to create mock execution functions that should not be called.
 * These are used in tests that only test properties commands or other non-execution functionality.
 */
function createMockExecutionFunctions() {
  return {
    runOnLxc: async () => {
      throw new Error("runOnLxc should not be called");
    },
    runOnVeHost: async () => {
      throw new Error("runOnVeHost should not be called");
    },
    executeOnHost: async () => {
      throw new Error("executeOnHost should not be called");
    },
  };
}

describe("VeExecutionCommandProcessor", () => {
  it("should process properties command with variable replacement in values", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {
      username: "macbckpsrv",
      password: "secret123",
      share_name: "backup",
    };
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "set-parameters",
      properties: [
        { id: "ostype", value: "debian" },
        { id: "volumes", value: "data=timemachine" },
        { id: "envs", value: "USERNAME={{username}}\nPASSWORD={{password}}\nSHARE_NAME={{share_name}}" },
      ],
      execute_on: "ve",
    };

    processor.handlePropertiesCommand(cmd, 0);

    // Verify outputs were set correctly
    expect(outputs.get("ostype")).toBe("debian");
    expect(outputs.get("volumes")).toBe("data=timemachine");

    // Verify that variables in envs were replaced
    const envsValue = outputs.get("envs");
    expect(envsValue).toBeDefined();
    expect(typeof envsValue).toBe("string");

    const envsStr = envsValue as string;
    // Check that variables were replaced
    expect(envsStr).toContain("USERNAME=macbckpsrv");
    expect(envsStr).toContain("PASSWORD=secret123");
    expect(envsStr).toContain("SHARE_NAME=backup");

    // Verify that the original variable placeholders are not present
    expect(envsStr).not.toContain("{{username}}");
    expect(envsStr).not.toContain("{{password}}");
    expect(envsStr).not.toContain("{{share_name}}");
  });

  it("should handle properties with single object", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {
      var: "replaced",
    };
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "set-single-property",
      properties: { id: "test_id", value: "test_{{var}}_value" },
      execute_on: "ve",
    };

    processor.handlePropertiesCommand(cmd, 0);

    expect(outputs.get("test_id")).toBe("test_replaced_value");
  });

  it("should handle properties with array of objects", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {
      var: "test",
    };
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "set-multiple-properties",
      properties: [
        { id: "prop1", value: "value1" },
        { id: "prop2", value: "value2_{{var}}" },
      ],
      execute_on: "ve",
    };

    processor.handlePropertiesCommand(cmd, 0);

    expect(outputs.get("prop1")).toBe("value1");
    expect(outputs.get("prop2")).toBe("value2_test");
  });

  it("should handle properties with missing id gracefully", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "invalid-properties",
      properties: { value: "test" } as any, // Missing id
      execute_on: "ve",
    };

    processor.handlePropertiesCommand(cmd, 0);

    // Outputs should be empty since id was missing
    expect(outputs.size).toBe(0);
  });

  it("should handle skipped commands", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "test (skipped)",
      description: "Skipped: all required parameters missing",
      command: "echo test",
      execute_on: "ve",
    };

    const msgIndex = processor.handleSkippedCommand(cmd, 0);
    expect(msgIndex).toBe(1);
  });

  it("should load command content from script file", () => {
    const scriptPath = path.join(testDir, "testscript.sh");
    fs.writeFileSync(scriptPath, "echo test script");

    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "test",
      script: scriptPath,
      execute_on: "ve",
    };

    const content = processor.loadCommandContent(cmd);
    expect(content).toBe("echo test script");
  });

  it("should load command content from command string", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    const cmd: ICommand = {
      name: "test",
      command: "echo test command",
      execute_on: "ve",
    };

    const content = processor.loadCommandContent(cmd);
    expect(content).toBe("echo test command");
  });

  it("should get vm_id from inputs or outputs", () => {
    const outputs = new Map<string, string | number | boolean>();
    const inputs: Record<string, string | number | boolean> = {};
    const defaults = new Map<string, string | number | boolean>();
    const variableResolver = new VariableResolver(
      () => outputs,
      () => inputs,
      () => defaults,
    );
    const eventEmitter = new EventEmitter();
    const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

    const mockExec = createMockExecutionFunctions();
    const processor = new VeExecutionCommandProcessor({
      outputs,
      inputs,
      variableResolver,
      messageEmitter,
      ...mockExec,
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });

    // Test with input
    inputs["vm_id"] = "101";
    expect(processor.getVmId()).toBe("101");

    // Test with output (should prefer input)
    outputs.set("vm_id", "102");
    expect(processor.getVmId()).toBe("101"); // Input takes precedence

    // Test with output only
    delete inputs["vm_id"];
    expect(processor.getVmId()).toBe("102");
  });

  describe("Library support (Option 3)", () => {
    it("should load script with library prepended", () => {
      const libraryPath = path.join(testDir, "test-library.sh");
      const scriptPath = path.join(testDir, "test-script.sh");
      
      // Create library with functions
      fs.writeFileSync(libraryPath, "test_function() { echo 'library function'; }");
      // Create script that uses library function
      fs.writeFileSync(scriptPath, "test_function");

      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();
      const variableResolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );
      const eventEmitter = new EventEmitter();
      const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

      const mockExec = createMockExecutionFunctions();
      const processor = new VeExecutionCommandProcessor({
        outputs,
        inputs,
        variableResolver,
        messageEmitter,
        ...mockExec,
        outputsRaw: undefined,
        setOutputsRaw: () => {},
      });

      const cmd: ICommand = {
        name: "test",
        script: scriptPath,
        libraryPath: libraryPath,
        execute_on: "ve",
      };

      const content = processor.loadCommandContent(cmd);
      expect(content).toContain("test_function() { echo 'library function'; }");
      expect(content).toContain("test_function");
      expect(content).toContain("# --- Script starts here ---");
      // Library should come before script
      const libraryIndex = content!.indexOf("test_function()");
      const scriptIndex = content!.indexOf("test_function", libraryIndex + 1);
      expect(libraryIndex).toBeLessThan(scriptIndex);
    });

    it("should throw error when library file not found", () => {
      const scriptPath = path.join(testDir, "test-script.sh");
      fs.writeFileSync(scriptPath, "echo test");

      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();
      const variableResolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );
      const eventEmitter = new EventEmitter();
      const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

      const mockExec = createMockExecutionFunctions();
      const processor = new VeExecutionCommandProcessor({
        outputs,
        inputs,
        variableResolver,
        messageEmitter,
        ...mockExec,
        outputsRaw: undefined,
        setOutputsRaw: () => {},
      });

      const cmd: ICommand = {
        name: "test",
        script: scriptPath,
        libraryPath: path.join(testDir, "non-existent-library.sh"),
        execute_on: "ve",
      };

      expect(() => processor.loadCommandContent(cmd)).toThrow(/Failed to read library file/);
    });

    it("should work without library when libraryPath is not specified", () => {
      const scriptPath = path.join(testDir, "test-script.sh");
      fs.writeFileSync(scriptPath, "echo test script");

      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();
      const variableResolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );
      const eventEmitter = new EventEmitter();
      const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

      const mockExec = createMockExecutionFunctions();
      const processor = new VeExecutionCommandProcessor({
        outputs,
        inputs,
        variableResolver,
        messageEmitter,
        ...mockExec,
        outputsRaw: undefined,
        setOutputsRaw: () => {},
      });

      const cmd: ICommand = {
        name: "test",
        script: scriptPath,
        execute_on: "ve",
      };

      const content = processor.loadCommandContent(cmd);
      expect(content).toBe("echo test script");
      expect(content).not.toContain("# --- Script starts here ---");
    });

    it("should prepend library content before script that calls library function", () => {
      const libraryPath = path.join(testDir, "test-library.sh");
      const scriptPath = path.join(testDir, "test-script.sh");
      
      // Create library with function
      fs.writeFileSync(libraryPath, "my_library_function() { echo 'from library'; }");
      // Create script that calls library function
      fs.writeFileSync(scriptPath, "my_library_function");

      const outputs = new Map<string, string | number | boolean>();
      const inputs: Record<string, string | number | boolean> = {};
      const defaults = new Map<string, string | number | boolean>();
      const variableResolver = new VariableResolver(
        () => outputs,
        () => inputs,
        () => defaults,
      );
      const eventEmitter = new EventEmitter();
      const messageEmitter = new VeExecutionMessageEmitter(eventEmitter);

      const mockExec = createMockExecutionFunctions();
      const processor = new VeExecutionCommandProcessor({
        outputs,
        inputs,
        variableResolver,
        messageEmitter,
        ...mockExec,
        outputsRaw: undefined,
        setOutputsRaw: () => {},
      });

      const cmd: ICommand = {
        name: "test",
        script: scriptPath,
        libraryPath: libraryPath,
        execute_on: "ve",
      };

      const content = processor.loadCommandContent(cmd);
      // Library should be prepended
      expect(content).toContain("my_library_function() { echo 'from library'; }");
      // Script should be after library
      expect(content).toContain("my_library_function");
      expect(content).toContain("# --- Script starts here ---");
      // Library should come before script marker
      const libraryIndex = content.indexOf("my_library_function()");
      const markerIndex = content.indexOf("# --- Script starts here ---");
      const scriptCallIndex = content.indexOf("my_library_function", libraryIndex + 1);
      expect(libraryIndex).toBeLessThan(markerIndex);
      expect(markerIndex).toBeLessThan(scriptCallIndex);
    });
  });
});

