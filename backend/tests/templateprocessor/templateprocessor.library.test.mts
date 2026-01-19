import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templates/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution/ve-execution-constants.mjs";
import { createTestEnvironment, type TestEnvironment } from "../helper/test-environment.mjs";
import { TestPersistenceHelper, Volume } from "@tests/helper/test-persistence-helper.mjs";

describe("TemplateProcessor - Library support", () => {
  let env: TestEnvironment;
  let persistenceHelper: TestPersistenceHelper;
  let contextManager: ReturnType<typeof PersistenceManager.getInstance>["getContextManager"];
  let tp: TemplateProcessor;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    env = createTestEnvironment(import.meta.url, {
      jsonIncludePatterns: [],
    });
    persistenceHelper = new TestPersistenceHelper({
      repoRoot: env.repoRoot,
      localRoot: env.localDir,
      jsonRoot: env.jsonDir,
      schemasRoot: env.schemaDir,
    });
    const { ctx } = env.initPersistence();
    contextManager = ctx;
    tp = contextManager.getTemplateProcessor();
  });

  afterAll(() => {
    env?.cleanup();
  });

  it("should error when library file not found", async () => {
    const templatesDir = persistenceHelper.resolve(Volume.JsonApplications, "test-library-app/templates");
    const scriptsDir = persistenceHelper.resolve(Volume.JsonApplications, "test-library-app/scripts");

    fs.mkdirSync(templatesDir, { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });

    // Create application.json
    const applicationJson = {
      "name": "Test Library App",
      "description": "Test application for library support",
      "installation": ["test-template.json"]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-library-app/application.json", applicationJson);

    // Create script
    persistenceHelper.writeTextSync(Volume.JsonApplications, "test-library-app/scripts/test-script.sh", "echo test");

    // Create template with non-existent library
    const template = {
      "execute_on": "ve",
      "name": "Test Template",
      "commands": [
        {
          "name": "Test Command",
          "script": "test-script.sh",
          "library": "non-existent-library.sh"
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-library-app/templates/test-template.json", template);

    try {
      await tp.loadApplication("test-library-app", "installation", veContext, ExecutionMode.TEST);
      expect.fail("Should have thrown an error");
    } catch (e: any) {
      // VEConfigurationError contains details array
      const errorMessage = e.message || String(e) || "";
      const errorDetails = e.details || [];
      const allErrors = [errorMessage, ...errorDetails.map((d: any) => d.message || String(d))].join(" ");
      expect(allErrors).toMatch(/Library file not found|non-existent-library/);
    }
  });

  it("should error when library contains template variables", async () => {
    const templatesDir = persistenceHelper.resolve(Volume.JsonApplications, "test-library-app/templates");
    const scriptsDir = persistenceHelper.resolve(Volume.JsonApplications, "test-library-app/scripts");

    fs.mkdirSync(templatesDir, { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });

    // Create library with template variable
    persistenceHelper.writeTextSync(Volume.JsonApplications, "test-library-app/scripts/test-library.sh", "function test() { echo '{{ variable }}'; }");

    // Create script
    persistenceHelper.writeTextSync(Volume.JsonApplications, "test-library-app/scripts/test-script.sh", "test");

    // Create template
    const template = {
      "execute_on": "ve",
      "name": "Test Template",
      "commands": [
        {
          "name": "Test Command",
          "script": "test-script.sh",
          "library": "test-library.sh"
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-library-app/templates/test-template.json", template);

    try {
      await tp.loadApplication("test-library-app", "installation", veContext, ExecutionMode.TEST);
      expect.fail("Should have thrown an error");
    } catch (e: any) {
      const errorMessage = e.message || String(e) || JSON.stringify(e);
      expect(errorMessage).toMatch(/contains template variables|variable/);
    }
  });

  it("should successfully load template with valid library", async () => {
    const templatesDir = persistenceHelper.resolve(Volume.JsonApplications, "test-library-app/templates");
    const scriptsDir = persistenceHelper.resolve(Volume.JsonApplications, "test-library-app/scripts");

    fs.mkdirSync(templatesDir, { recursive: true });
    fs.mkdirSync(scriptsDir, { recursive: true });

    // Create valid library (no template variables)
    persistenceHelper.writeTextSync(Volume.JsonApplications, "test-library-app/scripts/test-library.sh", "function test_function() { echo 'library function'; }");

    // Create script that uses library function
    persistenceHelper.writeTextSync(Volume.JsonApplications, "test-library-app/scripts/test-script.sh", "test_function");

    // Create template
    const template = {
      "execute_on": "ve",
      "name": "Test Template",
      "commands": [
        {
          "name": "Test Command",
          "script": "test-script.sh",
          "library": "test-library.sh"
        }
      ]
    };
    persistenceHelper.writeJsonSync(Volume.JsonApplications, "test-library-app/templates/test-template.json", template);

    const result = await tp.loadApplication("test-library-app", "installation", veContext, ExecutionMode.TEST);
    
    expect(result.commands.length).toBe(1);
    expect(result.commands[0].script).toBeDefined();
    expect(result.commands[0].libraryPath).toBeDefined();
    expect(result.commands[0].libraryPath).toContain("test-library.sh");
  });
});

