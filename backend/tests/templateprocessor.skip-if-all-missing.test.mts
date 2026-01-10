import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution-constants.mjs";

describe("TemplateProcessor skip_if_all_missing", () => {
  let testDir: string;
  let secretFilePath: string;
  let contextManager: ReturnType<typeof PersistenceManager.getInstance>["getContextManager"];
  let tp: TemplateProcessor;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    // Create a temporary directory for the test
    testDir = mkdtempSync(path.join(tmpdir(), "templateprocessor-skip-if-all-missing-test-"));
    secretFilePath = path.join(testDir, "secret.txt");

    // StorageContext uses rootDirname which is "../../" relative to backend/src
    // So jsonPath will be <repo-root>/json, not in testDir
    // We need to create the application in the actual json directory
    const __filename = new URL(import.meta.url).pathname;
    const backendDir = path.dirname(__filename);
    const repoRoot = path.join(backendDir, "../..");
    const jsonDir = path.join(repoRoot, "json");
    const applicationsDir = path.join(jsonDir, "applications");
    const testAppDir = path.join(applicationsDir, "test-skip-app");
    const templatesDir = path.join(testAppDir, "templates");
    
    mkdirSync(templatesDir, { recursive: true });

    // Create a valid storagecontext.json file
    const storageContextPath = path.join(testDir, "storagecontext.json");
    writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

    // Create application.json
    const applicationJson = {
      "name": "Test Skip Application",
      "description": "Test application for skip_if_all_missing",
      "installation": [
        "set-parameters.json",
        "optional-template-single.json",
        "optional-template-multiple.json"
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
              "id": "test_param",
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

    // Create optional-template-single.json - should be skipped if test_param is missing
    const optionalTemplateSingle = {
      "execute_on": "ve",
      "name": "Optional Template Single",
      "description": "Optional template with single parameter",
      "skip_if_all_missing": ["test_param"],
      "parameters": [
        {
          "id": "test_param",
          "name": "Test Parameter",
          "type": "string",
          "required": true,
          "description": "Test parameter"
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
      path.join(templatesDir, "optional-template-single.json"),
      JSON.stringify(optionalTemplateSingle),
      "utf-8"
    );

    // Create optional-template-multiple.json - should be skipped if BOTH param1 and param2 are missing
    const optionalTemplateMultiple = {
      "execute_on": "ve",
      "name": "Optional Template Multiple",
      "description": "Optional template with multiple parameters",
      "skip_if_all_missing": ["param1", "param2"],
      "parameters": [
        {
          "id": "param1",
          "name": "Parameter 1",
          "type": "string",
          "required": false,
          "description": "First parameter"
        },
        {
          "id": "param2",
          "name": "Parameter 2",
          "type": "string",
          "required": false,
          "description": "Second parameter"
        }
      ],
      "commands": [
        {
          "name": "Test Command Multiple",
          "command": "echo 'test command multiple executed'"
        }
      ]
    };
    writeFileSync(
      path.join(templatesDir, "optional-template-multiple.json"),
      JSON.stringify(optionalTemplateMultiple),
      "utf-8"
    );

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
    try {
      if (testDir && require("fs").existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
      const __filename = new URL(import.meta.url).pathname;
      const backendDir = path.dirname(__filename);
      const repoRoot = path.join(backendDir, "../..");
      const testAppDir = path.join(repoRoot, "json", "applications", "test-skip-app");
      if (require("fs").existsSync(testAppDir)) {
        rmSync(testAppDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should NOT skip template with single parameter when parameter is present", async () => {
    // test_param is provided by set-parameters.json (via properties command),
    // so it should be in resolvedParams when optional-template-single.json is processed.
    // Therefore, the template should NOT be skipped.
    
    const loaded = await tp.loadApplication(
      "test-skip-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // Verify test_param is in resolvedParams (it should be, because set-parameters.json outputs it)
    const resolvedParamIds = loaded.resolvedParams.map((p: any) => p.id);
    expect(resolvedParamIds).toContain("test_param");
    
    // Since test_param is present, the template should NOT be skipped
    // So there should be NO skipped command for "Optional Template Single"
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("Optional Template Single") && cmd.name.includes("(skipped)")
    );
    
    expect(skippedCommand).toBeUndefined();
    
    // There should be a regular command instead
    const regularCommand = loaded.commands.find((cmd: any) => 
      cmd.name === "Test Command" && !cmd.name.includes("(skipped)")
    );
    
    // The command should exist and not be skipped
    expect(regularCommand).toBeDefined();
    expect(regularCommand?.command).toBe("echo 'test command executed'");
  });

  it("should skip template with single parameter when parameter is missing", async () => {
    // Create a separate application for this test to avoid side effects
    const __filename = new URL(import.meta.url).pathname;
    const backendDir = path.dirname(__filename);
    const repoRoot = path.join(backendDir, "../..");
    const jsonDir = path.join(repoRoot, "json");
    const applicationsDir = path.join(jsonDir, "applications");
    const testAppDir2 = path.join(applicationsDir, "test-skip-app-2");
    const templatesDir2 = path.join(testAppDir2, "templates");
    
    mkdirSync(templatesDir2, { recursive: true });

    // Create application.json
    const applicationJson2 = {
      "name": "Test Skip Application 2",
      "description": "Test application for skip_if_all_missing - missing param",
      "installation": [
        "set-parameters-no-output.json",
        "optional-template-single.json"
      ]
    };
    writeFileSync(
      path.join(testAppDir2, "application.json"),
      JSON.stringify(applicationJson2),
      "utf-8"
    );

    // Create set-parameters.json that does NOT output test_param
    const setParametersTemplateNoOutput = {
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
      path.join(templatesDir2, "set-parameters-no-output.json"),
      JSON.stringify(setParametersTemplateNoOutput),
      "utf-8"
    );

    // Copy optional-template-single.json
    const optionalTemplateSingle = {
      "execute_on": "ve",
      "name": "Optional Template Single",
      "description": "Optional template with single parameter",
      "skip_if_all_missing": ["test_param"],
      "parameters": [
        {
          "id": "test_param",
          "name": "Test Parameter",
          "type": "string",
          "required": true,
          "description": "Test parameter"
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
      path.join(templatesDir2, "optional-template-single.json"),
      JSON.stringify(optionalTemplateSingle),
      "utf-8"
    );

    const loaded = await tp.loadApplication(
      "test-skip-app-2",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // test_param is NOT provided, so the template should be skipped
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("(skipped)") && cmd.command === "exit 0"
    );

    expect(skippedCommand).toBeDefined();
    expect(skippedCommand?.name).toContain("(skipped)");
    expect(skippedCommand?.command).toBe("exit 0");
    expect(skippedCommand?.description).toContain("Skipped");
    
    // Cleanup
    rmSync(testAppDir2, { recursive: true, force: true });
  });

  it("should skip template with multiple parameters when ALL are missing", async () => {
    // param1 and param2 are not provided by set-parameters.json (only test_param is),
    // so the template should be skipped
    const loaded = await tp.loadApplication(
      "test-skip-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // param1 and param2 are not provided, so the template should be skipped
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("(skipped)") && cmd.command === "exit 0"
    );

    expect(skippedCommand).toBeDefined();
    expect(skippedCommand?.name).toContain("(skipped)");
    expect(skippedCommand?.command).toBe("exit 0");
    expect(skippedCommand?.description).toContain("Skipped");
  });

  it("should NOT skip template with multiple parameters when at least one is present", async () => {
    // We need to create a template that provides param1
    // Let's modify set-parameters.json to also output param1
    const __filename = new URL(import.meta.url).pathname;
    const backendDir = path.dirname(__filename);
    const repoRoot = path.join(backendDir, "../..");
    const testAppDir = path.join(repoRoot, "json", "applications", "test-skip-app");
    const templatesDir = path.join(testAppDir, "templates");
    
    // Update set-parameters.json to also output param1
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
              "id": "test_param",
              "value": "test-value"
            },
            {
              "id": "param1",
              "value": "param1-value"
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

    const loaded = await tp.loadApplication(
      "test-skip-app",
      "installation",
      veContext,
      ExecutionMode.TEST,
    );

    // param1 is provided, so the template should NOT be skipped
    // (even though param2 is missing, at least one is present)
    const skippedCommand = loaded.commands.find((cmd: any) => 
      cmd.name && cmd.name.includes("Optional Template Multiple") && cmd.name.includes("(skipped)")
    );

    expect(skippedCommand).toBeUndefined();
    
    // There should be a regular command instead (not skipped)
    const regularCommand = loaded.commands.find((cmd: any) => 
      cmd.name === "Test Command Multiple" && !cmd.name.includes("(skipped)")
    );
    
    expect(regularCommand).toBeDefined();
    expect(regularCommand?.command).toBe("echo 'test command multiple executed'");
  });
});

