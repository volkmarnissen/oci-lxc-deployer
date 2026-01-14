import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution-constants.mjs";

describe("TemplateProcessor skip_if_property_set", () => {
  let testDir: string;
  let secretFilePath: string;
  let jsonDir: string;
  let contextManager: ReturnType<ReturnType<typeof PersistenceManager.getInstance>["getContextManager"]>;
  let tp: TemplateProcessor;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    // Create a temporary directory for the test
    testDir = mkdtempSync(path.join(tmpdir(), "templateprocessor-skip-if-property-set-test-"));
    secretFilePath = path.join(testDir, "secret.txt");

    // Use an isolated temp jsonDir for this suite
    jsonDir = path.join(testDir, "json");
    const applicationsDir = path.join(jsonDir, "applications");
    const testAppDir = path.join(applicationsDir, "test-skip-property-set-app");
    const templatesDir = path.join(testAppDir, "templates");
    
    mkdirSync(templatesDir, { recursive: true });

    // Create a valid storagecontext.json file
    const storageContextPath = path.join(testDir, "storagecontext.json");
    writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

    // Create application.json
    const applicationJson = {
      "name": "Test Skip Property Set Application",
      "description": "Test application for skip_if_property_set",
      "installation": [
        "set-parameters.json",
        "skip-if-property-set-template.json"
      ]
    };
    writeFileSync(
      path.join(testAppDir, "application.json"),
      JSON.stringify(applicationJson),
      "utf-8"
    );

    // Create set-parameters.json template that outputs a parameter
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
        }
      ],
      "commands": [
        {
          "properties": [
            {
              "id": "myvariable",
              "value": "test-value"
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

    // Create skip-if-property-set-template.json - should be skipped if myvariable is set
    const skipIfPropertySetTemplate = {
      "execute_on": "ve",
      "name": "Skip If Property Set Template",
      "description": "Template that is skipped if myvariable is set",
      "skip_if_property_set": "myvariable",
      "parameters": [
        {
          "id": "other_param",
          "name": "Other Parameter",
          "type": "string",
          "required": false,
          "description": "Other parameter"
        }
      ],
      "commands": [
        {
          "name": "Test Command",
          "command": "echo 'test command executed'"
        }
      ]
    };
    writeFileSync(
      path.join(templatesDir, "skip-if-property-set-template.json"),
      JSON.stringify(skipIfPropertySetTemplate),
      "utf-8"
    );

    // Close existing instance if any
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }
    // Initialize PersistenceManager with isolated jsonDir and real schemas
    const __filename = new URL(import.meta.url).pathname;
    const backendDir = path.dirname(__filename);
    const repoRoot = path.join(backendDir, "../..");
    const schemaPath = path.join(repoRoot, "schemas");
    PersistenceManager.initialize(
      testDir,
      storageContextPath,
      secretFilePath,
      false, // disable cache for tests
      jsonDir,
      schemaPath,
    );
    const pm = PersistenceManager.getInstance();
    contextManager = pm.getContextManager();
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    try {
      if (testDir && require("fs").existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should skip template when skip_if_property_set variable is set", async () => {
    // myvariable is provided by set-parameters.json (via properties command),
    // so it should be in resolvedParams when skip-if-property-set-template.json is processed.
    // Therefore, the template should be skipped.
    
    const loaded = await tp.loadApplication(
      "test-skip-property-set-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // Verify myvariable is in resolvedParams (it should be, because set-parameters.json outputs it)
    const resolvedParamIds = loaded.resolvedParams.map((p: any) => p.id);
    expect(resolvedParamIds).toContain("myvariable");
    
    // Since myvariable is present, the template should be skipped
    // The command name will be "Test Command (skipped)" because cmd.name is used
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("(skipped)") && cmd.command === "exit 0"
    );
    
    expect(skippedCommand).toBeDefined();
    expect(skippedCommand?.command).toBe("exit 0");
    expect(skippedCommand?.description).toContain("Skipped");
    
    // There should NOT be a regular command
    const regularCommand = loaded.commands.find((cmd: any) => 
      cmd.name === "Test Command" && !cmd.name.includes("(skipped)")
    );
    
    expect(regularCommand).toBeUndefined();
  });

  it("should NOT skip template when skip_if_property_set variable is NOT set", async () => {
    // Create a separate application for this test to avoid side effects
    const applicationsDir = path.join(jsonDir, "applications");
    const testAppDir2 = path.join(applicationsDir, "test-skip-property-set-app-2");
    const templatesDir2 = path.join(testAppDir2, "templates");
    
    mkdirSync(templatesDir2, { recursive: true });

    // Create application.json
    const applicationJson2 = {
      "name": "Test Skip Property Set Application 2",
      "description": "Test application for skip_if_property_set - variable not set",
      "installation": [
        "set-parameters-no-myvariable.json",
        "skip-if-property-set-template.json"
      ]
    };
    writeFileSync(
      path.join(testAppDir2, "application.json"),
      JSON.stringify(applicationJson2),
      "utf-8"
    );

    // Create set-parameters.json that does NOT output myvariable
    const setParametersTemplateNoMyVariable = {
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
        }
      ],
      "commands": [
        {
          "properties": [
            {
              "id": "other_param",
              "value": "other-value"
            }
          ]
        }
      ]
    };
    writeFileSync(
      path.join(templatesDir2, "set-parameters-no-myvariable.json"),
      JSON.stringify(setParametersTemplateNoMyVariable),
      "utf-8"
    );

    // Copy skip-if-property-set-template.json
    const skipIfPropertySetTemplate = {
      "execute_on": "ve",
      "name": "Skip If Property Set Template",
      "description": "Template that is skipped if myvariable is set",
      "skip_if_property_set": "myvariable",
      "parameters": [
        {
          "id": "other_param",
          "name": "Other Parameter",
          "type": "string",
          "required": false,
          "description": "Other parameter"
        }
      ],
      "commands": [
        {
          "name": "Test Command",
          "command": "echo 'test command executed'"
        }
      ]
    };
    writeFileSync(
      path.join(templatesDir2, "skip-if-property-set-template.json"),
      JSON.stringify(skipIfPropertySetTemplate),
      "utf-8"
    );

    const loaded = await tp.loadApplication(
      "test-skip-property-set-app-2",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // myvariable is NOT provided, so the template should NOT be skipped
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("Skip If Property Set Template") && cmd.name.includes("(skipped)")
    );

    expect(skippedCommand).toBeUndefined();
    
    // There should be a regular command instead
    const regularCommand = loaded.commands.find((cmd: any) => 
      cmd.name === "Test Command" && !cmd.name.includes("(skipped)")
    );
    
    expect(regularCommand).toBeDefined();
    expect(regularCommand?.command).toBe("echo 'test command executed'");
    
    // Cleanup
    rmSync(testAppDir2, { recursive: true, force: true });
  });
});

