import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { DocumentationGenerator } from "@src/documentation-generator.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";

describe("DocumentationGenerator skip_if_property_set", () => {
  let jsonPath: string;
  let localPath: string;
  let schemaPath: string;
  let htmlPath: string;
  let secretFilePath: string;
  let testAppPath: string;

  beforeAll(() => {
    // Use project root paths (StorageContext uses hardcoded paths from import.meta.url)
    const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
    jsonPath = path.join(projectRoot, "json");
    localPath = path.join(projectRoot, "local", "json");
    schemaPath = path.join(projectRoot, "schemas");
    
    // Use normal html path in project root
    htmlPath = path.join(projectRoot, "html");
    secretFilePath = path.join(localPath, "secret.txt");

    // Create directory structure in project json directory
    testAppPath = path.join(jsonPath, "applications", "test-skip-property-set-doc-app");
    fs.mkdirSync(path.join(testAppPath, "templates"), { recursive: true });
    fs.mkdirSync(path.join(testAppPath, "scripts"), { recursive: true });
    
    // Create StorageContext with project paths
    const storageContextPath = path.join(localPath, "storagecontext.json");
    if (!fs.existsSync(path.dirname(storageContextPath))) {
      fs.mkdirSync(path.dirname(storageContextPath), { recursive: true });
    }
    if (!fs.existsSync(storageContextPath)) {
      writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");
    }
    if (!fs.existsSync(secretFilePath)) {
      writeFileSync(secretFilePath, "", "utf-8");
    }
    // Close existing instance if any
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }
    PersistenceManager.initialize(localPath, storageContextPath, secretFilePath);

    // Create test application.json
    const appJson = {
      name: "Test Skip Property Set Doc Application",
      description: "A test application for skip_if_property_set documentation",
      installation: [
        "set-parameters.json",
        "skip-if-property-set-template.json",
      ],
    };
    writeFileSync(
      path.join(jsonPath, "applications", "test-skip-property-set-doc-app", "application.json"),
      JSON.stringify(appJson, null, 2),
      "utf-8",
    );

    // Create test set-parameters.json template
    const setParamsTemplate = {
      name: "Set Parameters",
      description: "Sets application-specific parameters",
      execute_on: "ve",
      commands: [
        {
          properties: [
            { id: "myvariable", value: "test-value" },
          ],
        },
      ],
      parameters: [
        {
          id: "hostname",
          name: "Hostname",
          type: "string",
          required: true,
          description: "Hostname for the container",
        },
      ],
    };
    writeFileSync(
      path.join(jsonPath, "applications", "test-skip-property-set-doc-app", "templates", "set-parameters.json"),
      JSON.stringify(setParamsTemplate, null, 2),
      "utf-8",
    );

    // Create test template with skip_if_property_set
    const skipIfPropertySetTemplate = {
      name: "Skip If Property Set Template",
      description: "Template that is skipped if myvariable is set",
      execute_on: "ve",
      skip_if_property_set: "myvariable",
      commands: [
        {
          name: "Test Command",
          command: "echo 'test command'",
          description: "Test command that should be skipped",
        },
      ],
      parameters: [
        {
          id: "other_param",
          name: "Other Parameter",
          type: "string",
          required: false,
          description: "Other parameter",
        },
      ],
    };
    writeFileSync(
      path.join(jsonPath, "applications", "test-skip-property-set-doc-app", "templates", "skip-if-property-set-template.json"),
      JSON.stringify(skipIfPropertySetTemplate, null, 2),
      "utf-8",
    );
  });

  afterAll(() => {
    try {
      // Cleanup test application
      if (testAppPath && fs.existsSync(testAppPath)) {
        rmSync(testAppPath, { recursive: true, force: true });
      }
      // Cleanup generated html files
      const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../..");
      const htmlAppPath = path.join(htmlPath, "test-skip-property-set-doc-app.md");
      if (fs.existsSync(htmlAppPath)) {
        rmSync(htmlAppPath, { force: true });
      }
      const htmlTemplatePath = path.join(htmlPath, "json", "applications", "test-skip-property-set-doc-app");
      if (fs.existsSync(htmlTemplatePath)) {
        rmSync(htmlTemplatePath, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it("should mark template as skipped in Application.md when skip_if_property_set variable is set", async () => {
    const generator = new DocumentationGenerator(jsonPath, localPath, schemaPath, htmlPath);
    
    // Generate documentation for the test application
    await generator.generateDocumentation("test-skip-property-set-doc-app");
    
    // Read the generated README.md (it's generated in htmlPath, not in jsonPath)
    const readmePath = path.join(
      htmlPath,
      "test-skip-property-set-doc-app.md",
    );
    
    expect(fs.existsSync(readmePath)).toBe(true);
    
    const readmeContent = fs.readFileSync(readmePath, "utf-8");
    
    // Check that the template is marked as skipped
    // The status should indicate that it's conditionally executed and skipped
    expect(readmeContent).toContain("skip-if-property-set-template.json");
    
    // The template should appear in the Installation Templates section
    expect(readmeContent).toMatch(/skip-if-property-set-template/i);
    
    // Check that the template is recognized as conditionally executed
    // (skip_if_property_set makes it conditional)
    // The template should be marked with a conditional status
    // Since skip_if_property_set is set, the template is conditional
    const lines = readmeContent.split('\n');
    const templateLine = lines.find(line => line.includes('skip-if-property-set-template'));
    expect(templateLine).toBeTruthy();
    if (templateLine) {
      // The line should contain the template name and a status indicator
      // Since skip_if_property_set is set, the template is conditional
      // The status should be "⚠️ Conditional" or similar
      expect(templateLine).toMatch(/⚠️|Conditional|conditional/i);
    }
  });

  it("should recognize skip_if_property_set as conditional in template analyzer", async () => {
    const { TemplateAnalyzer } = await import("@src/template-analyzer.mjs");
    const { DocumentationPathResolver } = await import("@src/documentation-path-resolver.mjs");
    
    const pathResolver = new DocumentationPathResolver(jsonPath, localPath);
    const templateAnalyzer = new TemplateAnalyzer(pathResolver, {
      jsonPath,
      schemaPath,
      localPath,
    });
    
    const templatePath = path.join(
      jsonPath,
      "applications",
      "test-skip-property-set-doc-app",
      "templates",
      "skip-if-property-set-template.json",
    );
    
    const templateData = JSON.parse(fs.readFileSync(templatePath, "utf-8"));
    
    // Check that skip_if_property_set is recognized as conditional
    const isConditional = templateAnalyzer.isConditionallyExecuted(templateData);
    expect(isConditional).toBe(true);
  });
});

