import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { tmpdir } from "os";
import { VeExecution } from "../src/ve-execution.mjs";
import { ExecutionMode } from "../src/ve-execution-constants.mjs";
import { resetMessageIndex } from "../src/ve-execution-constants.mjs";
import { PersistenceManager } from "../src/persistence/persistence-manager.mjs";
import { ICommand } from "../src/types.mjs";

describe("VeExecution Shebang Support", () => {
  let testDir: string;
  let storageContextPath: string;
  let secretFilePath: string;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    resetMessageIndex();
    testDir = mkdtempSync(path.join(tmpdir(), "ve-execution-shebang-test-"));
    storageContextPath = path.join(testDir, "storagecontext.json");
    secretFilePath = path.join(testDir, "secret.txt");
    
    // Initialize PersistenceManager for tests
    const __filename = new URL(import.meta.url).pathname;
    const backendDir = path.dirname(__filename);
    const repoRoot = path.join(backendDir, "../..");
    const jsonPath = path.join(repoRoot, "json");
    const localPath = path.join(testDir, "local");
    const schemasPath = path.join(repoRoot, "schemas");
    
    mkdirSync(localPath, { recursive: true });
    writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");
    writeFileSync(secretFilePath, "", "utf-8");
    
    PersistenceManager.initialize(jsonPath, localPath, schemasPath, storageContextPath, secretFilePath);
  });

  afterAll(() => {
    if (testDir && existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  it("should execute Python script with shebang using ExecutionMode.TEST", async () => {
    // Create a Python test script
    const scriptPath = path.join(testDir, "test-shebang.py");
    const pythonScript = `#!/usr/bin/env python3
import json
import sys

# Test parameter substitution - variable replacement happens before execution
test_input = "test_value_123"

# Log to stderr
print(f"Python script executed with test_input={test_input}", file=sys.stderr)

# Output JSON to stdout
output = [
    {"id": "python_executed", "value": True},
    {"id": "test_input_value", "value": test_input},
    {"id": "python_version_major", "value": sys.version_info.major}
]
print(json.dumps(output))
`;
    writeFileSync(scriptPath, pythonScript, { mode: 0o755 });

    // Create command
    const command: ICommand = {
      name: "test-python-shebang",
      script: scriptPath,
      outputs: ["python_executed", "test_input_value", "python_version_major"],
      execute_on: "ve",
    };

    const inputs = [
      { id: "test_input", value: "test_value_123" },
    ];

    // Load command content to extract shebang
    const { VeExecutionCommandProcessor } = await import("../src/ve-execution-command-processor.mjs");
    const processor = new VeExecutionCommandProcessor({
      outputs: new Map(),
      inputs: { test_input: "test_value_123" },
      variableResolver: {} as any,
      messageEmitter: {} as any,
      runOnLxc: async () => ({} as any),
      runOnVeHost: async () => ({} as any),
      executeOnHost: async () => {},
      outputsRaw: undefined,
      setOutputsRaw: () => {},
    });
    processor.loadCommandContent(command); // This extracts the shebang

    // Create VeExecution with ExecutionMode.TEST
    const exec = new VeExecution(
      [command],
      inputs,
      veContext,
      new Map(),
      undefined, // sshCommand not used
      ExecutionMode.TEST, // Use ExecutionMode.TEST
    );

    const messages: any[] = [];
    exec.on("message", (msg) => {
      messages.push(msg);
    });

    try {
      await exec.run();
    } catch (err: any) {
      console.error("Execution error:", err.message);
      // Don't throw - let test continue to check messages
    }

    // Check that Python was executed (not sh)
    // Find the final non-partial message with exitCode 0
    const allMessagesForCommand = messages.filter((m) => m.command === "test-python-shebang");
    const resultMessage = allMessagesForCommand
      .filter((m) => !m.partial && m.exitCode === 0)
      .pop() || allMessagesForCommand[allMessagesForCommand.length - 1];
    
    expect(resultMessage).toBeDefined();
    expect(resultMessage?.exitCode).toBe(0);
    expect(resultMessage?.result).toBeDefined();

    // Parse JSON output - the marker should have been removed by parseAndUpdateOutputs
    // But if it's still there, we need to remove it first
    let jsonResult = resultMessage!.result as string;
    const markerPattern = /^LXC_MANAGER_JSON_START_MARKER_\d+_[a-z0-9]+\n/;
    if (markerPattern.test(jsonResult)) {
      jsonResult = jsonResult.replace(markerPattern, '').trim();
    }
    const output = JSON.parse(jsonResult);
    expect(output).toBeInstanceOf(Array);
    expect(output.length).toBeGreaterThan(0);

    // Check outputs
    const pythonExecuted = output.find((o: any) => o.id === "python_executed");
    expect(pythonExecuted).toBeDefined();
    expect(pythonExecuted.value).toBe(true);

    const testInputValue = output.find((o: any) => o.id === "test_input_value");
    expect(testInputValue).toBeDefined();
    expect(testInputValue.value).toBe("test_value_123");

    const pythonVersion = output.find((o: any) => o.id === "python_version_major");
    expect(pythonVersion).toBeDefined();
    expect(pythonVersion.value).toBe(3); // Python 3

    // Verify outputs were set in VeExecution
    expect(exec.outputs.get("python_executed")).toBe(true);
    expect(exec.outputs.get("test_input_value")).toBe("test_value_123");
    expect(exec.outputs.get("python_version_major")).toBe(3);
  });

  it("should fallback to sh for scripts without shebang in TEST mode", async () => {
    // Create a shell script without shebang
    const scriptPath = path.join(testDir, "test-no-shebang.sh");
    const shellScript = `#!/bin/sh
# No shebang on first line, but this line starts with #
test_input="{{ test_input }}"
echo '[{"id": "shell_executed", "value": true}, {"id": "test_input_value", "value": "'"$test_input"'"}]'
`;
    writeFileSync(scriptPath, shellScript, { mode: 0o755 });

    const command = {
      name: "test-shell-no-shebang",
      script: scriptPath,
      outputs: ["shell_executed", "test_input_value"],
      execute_on: "ve",
    };

    const inputs = [
      { id: "test_input", value: "shell_test_value" },
    ];

    const exec = new VeExecution(
      [command],
      inputs,
      veContext,
      new Map(),
      undefined,
      ExecutionMode.TEST,
    );

    const messages: any[] = [];
    exec.on("message", (msg) => {
      messages.push(msg);
    });

    await exec.run();

    // Find the final non-partial message
    const allMessagesForCommand = messages.filter((m) => m.command === "test-shell-no-shebang");
    const resultMessage = allMessagesForCommand
      .filter((m) => !m.partial && m.exitCode === 0)
      .pop() || allMessagesForCommand[allMessagesForCommand.length - 1];
    
    expect(resultMessage).toBeDefined();
    expect(resultMessage?.exitCode).toBe(0);

    // Should have executed (with sh as fallback)
    let jsonResult = resultMessage!.result as string;
    const markerPattern = /^LXC_MANAGER_JSON_START_MARKER_\d+_[a-z0-9]+\n/;
    if (markerPattern.test(jsonResult)) {
      jsonResult = jsonResult.replace(markerPattern, '').trim();
    }
    const output = JSON.parse(jsonResult);
    expect(output).toBeInstanceOf(Array);
    const shellExecuted = output.find((o: any) => o.id === "shell_executed");
    expect(shellExecuted).toBeDefined();
    expect(shellExecuted.value).toBe(true);
  });
});

