import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution-constants.mjs";

describe("TemplateProcessor properties outputs generation", () => {
  let testDir: string;
  let secretFilePath: string;
  let contextManager: ReturnType<typeof PersistenceManager.getInstance>["getContextManager"];
  let tp: TemplateProcessor;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    // Create a temporary directory for the test
    testDir = mkdtempSync(path.join(tmpdir(), "templateprocessor-properties-outputs-test-"));
    secretFilePath = path.join(testDir, "secret.txt");

    // StorageContext uses rootDirname which is "../../" relative to backend/src
    // So jsonPath will be <repo-root>/json, not in testDir
    // We need to create the application in the actual json directory
    const __filename = new URL(import.meta.url).pathname;
    const backendDir = path.dirname(__filename);
    const repoRoot = path.join(backendDir, "../..");
    const jsonDir = path.join(repoRoot, "json");
    const applicationsDir = path.join(jsonDir, "applications");
    const testAppDir = path.join(applicationsDir, "test-app");
    const templatesDir = path.join(testAppDir, "templates");
    
    mkdirSync(templatesDir, { recursive: true });

    // Create a valid storagecontext.json file
    const storageContextPath = path.join(testDir, "storagecontext.json");
    writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

    // Note: Schemas are loaded from <repo-root>/schemas, so we don't need to create them
    // The real schemas will be used

    // Create application.json
    const applicationJson = {
      "name": "Test Application",
      "description": "Test application for properties outputs",
      "installation": ["set-parameters.json"]
    };
    writeFileSync(
      path.join(testAppDir, "application.json"),
      JSON.stringify(applicationJson),
      "utf-8"
    );

    // Create set-parameters.json template (based on the real one)
    const setParametersTemplate = {
      "execute_on": "ve",
      "name": "Set Parameters",
      "description": "Set application-specific parameters",
      "parameters": [
        {
          "id": "hostname",
          "name": "Hostname",
          "type": "string",
          "default": "test",
          "required": true,
          "description": "Hostname for the container"
        },
        {
          "id": "uid",
          "name": "UID",
          "type": "string",
          "default": "1000",
          "description": "UID for permissions",
          "advanced": true
        },
        {
          "id": "gid",
          "name": "GID",
          "type": "string",
          "default": "1000",
          "description": "GID for permissions",
          "advanced": true
        }
      ],
      "commands": [
        {
          "properties": [
            {
              "id": "ostype",
              "value": "debian"
            },
            {
              "id": "oci_image",
              "value": "test/image"
            },
            {
              "id": "uid",
              "value": "{{uid}}"
            },
            {
              "id": "gid",
              "value": "{{gid}}"
            },
            {
              "id": "volumes",
              "value": "data=test"
            },
            {
              "id": "envs",
              "value": "USERNAME={{hostname}}\nPASSWORD=secret"
            }
          ]
        }
      ]
    };
    writeFileSync(
      path.join(templatesDir, "set-parameters.json"),
      JSON.stringify(setParametersTemplate),
      "utf-8"
    );

    // Ensure global StorageContext instance is set
    // Close existing instance if any
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }
    PersistenceManager.initialize(testDir, storageContextPath, secretFilePath);
    const pm = PersistenceManager.getInstance();
    contextManager = pm.getContextManager();
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    // Cleanup test directory and test application
    try {
      if (testDir && require("fs").existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
      // Remove test application from json directory
      const __filename = new URL(import.meta.url).pathname;
      const backendDir = path.dirname(__filename);
      const repoRoot = path.join(backendDir, "../..");
      const testAppDir = path.join(repoRoot, "json", "applications", "test-app");
      if (require("fs").existsSync(testAppDir)) {
        rmSync(testAppDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should automatically generate outputs from properties commands", async () => {
    let loaded;
    try {
      loaded = await tp.loadApplication(
        "test-app",
        "installation",
        veContext,
        ExecutionMode.TEST,
      );
    } catch (err: any) {
      console.error("Error loading application:", err);
      if (err.details) {
        console.error("Error details:", JSON.stringify(err.details, null, 2));
      }
      throw err;
    }

    // Check that all property IDs are in resolvedParams (which means they were treated as outputs)
    const resolvedParamIds = loaded.resolvedParams.map((p) => p.id);
    
    // All IDs from properties should be in resolvedParams
    expect(resolvedParamIds).toContain("ostype");
    expect(resolvedParamIds).toContain("oci_image");
    expect(resolvedParamIds).toContain("uid");
    expect(resolvedParamIds).toContain("gid");
    expect(resolvedParamIds).toContain("volumes");
    expect(resolvedParamIds).toContain("envs");

    // Verify they were marked as resolved from the set-parameters template
    const ostypeParam = loaded.resolvedParams.find((p) => p.id === "ostype");
    expect(ostypeParam).toBeDefined();
    expect(ostypeParam?.template).toBe("set-parameters.json");

    const ociImageParam = loaded.resolvedParams.find((p) => p.id === "oci_image");
    expect(ociImageParam).toBeDefined();
    expect(ociImageParam?.template).toBe("set-parameters.json");

    const volumesParam = loaded.resolvedParams.find((p) => p.id === "volumes");
    expect(volumesParam).toBeDefined();
    expect(volumesParam?.template).toBe("set-parameters.json");

    const envsParam = loaded.resolvedParams.find((p) => p.id === "envs");
    expect(envsParam).toBeDefined();
    expect(envsParam?.template).toBe("set-parameters.json");
  });

  it("should handle properties with variable substitution in values", async () => {
    const loaded = await tp.loadApplication(
      "test-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // uid and gid should be in resolvedParams even though they reference variables
    const resolvedParamIds = loaded.resolvedParams.map((p) => p.id);
    expect(resolvedParamIds).toContain("uid");
    expect(resolvedParamIds).toContain("gid");

    // These should be marked as resolved from set-parameters
    const uidParam = loaded.resolvedParams.find((p) => p.id === "uid");
    expect(uidParam).toBeDefined();
    expect(uidParam?.template).toBe("set-parameters.json");

    const gidParam = loaded.resolvedParams.find((p) => p.id === "gid");
    expect(gidParam).toBeDefined();
    expect(gidParam?.template).toBe("set-parameters.json");
  });
});

