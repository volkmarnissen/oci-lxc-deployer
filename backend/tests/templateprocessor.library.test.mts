import { describe, it, expect, beforeAll, afterAll } from "vitest";
import path from "path";
import fs from "fs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { TemplateProcessor } from "@src/templateprocessor.mjs";
import { ExecutionMode } from "@src/ve-execution-constants.mjs";

describe("TemplateProcessor - Library support", () => {
  let testDir: string;
  let secretFilePath: string;
  let contextManager: ReturnType<typeof PersistenceManager.getInstance>["getContextManager"];
  let tp: TemplateProcessor;
  const veContext = { host: "localhost", port: 22 } as any;

  beforeAll(() => {
    testDir = mkdtempSync(path.join(tmpdir(), "templateprocessor-library-test-"));
    secretFilePath = path.join(testDir, "secret.txt");

    const storageContextPath = path.join(testDir, "storagecontext.json");
    writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");

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
      if (testDir && fs.existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should error when library file not found", async () => {
    const applicationsDir = path.join(testDir, "applications");
    const testAppDir = path.join(applicationsDir, "test-library-app");
    const templatesDir = path.join(testAppDir, "templates");
    const scriptsDir = path.join(testAppDir, "scripts");

    mkdirSync(templatesDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });

    // Create application.json
    const applicationJson = {
      "name": "Test Library App",
      "description": "Test application for library support",
      "installation": ["test-template.json"]
    };
    writeFileSync(
      path.join(testAppDir, "application.json"),
      JSON.stringify(applicationJson),
      "utf-8"
    );

    // Create script
    writeFileSync(
      path.join(scriptsDir, "test-script.sh"),
      "echo test",
      "utf-8"
    );

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
    writeFileSync(
      path.join(templatesDir, "test-template.json"),
      JSON.stringify(template),
      "utf-8"
    );

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
    const applicationsDir = path.join(testDir, "applications");
    const testAppDir = path.join(applicationsDir, "test-library-app");
    const templatesDir = path.join(testAppDir, "templates");
    const scriptsDir = path.join(testAppDir, "scripts");

    mkdirSync(templatesDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });

    // Create library with template variable
    writeFileSync(
      path.join(scriptsDir, "test-library.sh"),
      "function test() { echo '{{ variable }}'; }",
      "utf-8"
    );

    // Create script
    writeFileSync(
      path.join(scriptsDir, "test-script.sh"),
      "test",
      "utf-8"
    );

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
    writeFileSync(
      path.join(templatesDir, "test-template.json"),
      JSON.stringify(template),
      "utf-8"
    );

    try {
      await tp.loadApplication("test-library-app", "installation", veContext, ExecutionMode.TEST);
      expect.fail("Should have thrown an error");
    } catch (e: any) {
      const errorMessage = e.message || String(e) || JSON.stringify(e);
      expect(errorMessage).toMatch(/contains template variables|variable/);
    }
  });

  it("should successfully load template with valid library", async () => {
    const applicationsDir = path.join(testDir, "applications");
    const testAppDir = path.join(applicationsDir, "test-library-app");
    const templatesDir = path.join(testAppDir, "templates");
    const scriptsDir = path.join(testAppDir, "scripts");

    mkdirSync(templatesDir, { recursive: true });
    mkdirSync(scriptsDir, { recursive: true });

    // Create valid library (no template variables)
    writeFileSync(
      path.join(scriptsDir, "test-library.sh"),
      "function test_function() { echo 'library function'; }",
      "utf-8"
    );

    // Create script that uses library function
    writeFileSync(
      path.join(scriptsDir, "test-script.sh"),
      "test_function",
      "utf-8"
    );

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
    writeFileSync(
      path.join(templatesDir, "test-template.json"),
      JSON.stringify(template),
      "utf-8"
    );

    const result = await tp.loadApplication("test-library-app", "installation", veContext, ExecutionMode.TEST);
    
    expect(result.commands.length).toBe(1);
    expect(result.commands[0].script).toBeDefined();
    expect(result.commands[0].libraryPath).toBeDefined();
    expect(result.commands[0].libraryPath).toContain("test-library.sh");
  });
});

