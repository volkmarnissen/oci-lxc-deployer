import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { ExecutionMode } from "@src/ve-execution-constants.mjs";
// TaskType is a string union; use literal values

describe("TemplateProcessor enum handling", () => {
  let testDir: string;
  let localPath: string;
  let secretFilePath: string;
  let storageContextPath: string;
  let contextManager: ReturnType<ReturnType<typeof PersistenceManager.getInstance>["getContextManager"]>;
  let tp: any;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    // Create a temporary directory for the test
    testDir = mkdtempSync(path.join(tmpdir(), "templateprocessor-enum-test-"));
    localPath = path.join(testDir, "local");
    secretFilePath = path.join(testDir, "secret.txt");
    storageContextPath = path.join(testDir, "storagecontext.json");

    // Create required directories
    writeFileSync(secretFilePath, "", "utf-8");
    writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

    // Close existing instance if any
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }
    
    PersistenceManager.initialize(localPath, storageContextPath, secretFilePath);
    const pm = PersistenceManager.getInstance();
    contextManager = pm.getContextManager();
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    // Cleanup test directory
    try {
      if (testDir && require("fs").existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it("keeps static enum values unchanged", async () => {
    const loaded = await tp.loadApplication(
      "test-enum",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );
    const staticParam = loaded.parameters.find(
      (p: { id: string }) => p.id === "color",
    );
    expect(staticParam).toBeDefined();
    // Validate correct enumeration regardless of underlying implementation
    expect(Array.isArray(staticParam?.enumValues)).toBe(true);
    expect(staticParam?.enumValues).toContain("red");
    expect(staticParam?.enumValues).toContain("green");
    expect(staticParam?.enumValues).toContain("blue");
  });

  it("exposes dynamic enum template reference for UI", async () => {
    const loaded = await tp.loadApplication(
      "test-enum",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );
    const dynParam = loaded.parameters.find(
      (p: { id: string }) => p.id === "iface",
    );
    expect(dynParam).toBeDefined();
    // TemplateProcessor should surface the enumValuesTemplate to webuiTemplates
    expect(loaded.webuiTemplates).toContain("list-enum-values.json");
    // And should inject enumValues from the template output
    // The template returns [{name: "eth0", value: "eth0"}, {name: "eth1", value: "eth1"}]
    // TemplateProcessor assigns rc.outputs directly to enumValues
    const enumValues = (dynParam as any).enumValues;
    expect(Array.isArray(enumValues)).toBe(true);
    expect(enumValues.length).toBe(2);
    // Check that it contains the expected objects
    expect(enumValues).toContainEqual({ name: "eth0", value: "eth0" });
    expect(enumValues).toContainEqual({ name: "eth1", value: "eth1" });
  });
});
