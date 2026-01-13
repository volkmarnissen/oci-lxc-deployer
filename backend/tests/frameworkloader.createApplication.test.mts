import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import fs, { mkdtempSync, rmSync, existsSync, mkdirSync, copyFileSync } from "node:fs";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { ContextManager } from "@src/context-manager.mjs";
import { IPostFrameworkCreateApplicationBody } from "@src/types.mjs";
import { IApplication } from "@src/backend-types.mjs";
import { ITemplate } from "@src/types.mjs";

describe("FrameworkLoader.createApplicationFromFramework", () => {
  let tempDir: string;
  let tempJsonDir: string;
  let repoRoot: string;
  let contextManager: ContextManager;
  let loader: FrameworkLoader;

  beforeEach(() => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    repoRoot = path.resolve(__dirname, "..", "..");
    tempDir = mkdtempSync(path.join(os.tmpdir(), "lxc-fw-create-"));
    tempJsonDir = mkdtempSync(path.join(os.tmpdir(), "lxc-fw-json-"));
    const storageContextFile = path.join(tempDir, "storagecontext.json");
    const secretFile = path.join(tempDir, "secret.txt");

    // Copy required framework and application to temp json directory
    const realJsonPath = path.join(repoRoot, "json");
    const frameworksDir = path.join(tempJsonDir, "frameworks");
    const applicationsDir = path.join(tempJsonDir, "applications");
    mkdirSync(frameworksDir, { recursive: true });
    mkdirSync(applicationsDir, { recursive: true });

    // Copy npm-nodejs framework
    const npmFrameworkSource = path.join(realJsonPath, "frameworks", "npm-nodejs.json");
    if (existsSync(npmFrameworkSource)) {
      copyFileSync(npmFrameworkSource, path.join(frameworksDir, "npm-nodejs.json"));
    }

    // Copy npm-nodejs application (base application for the framework)
    const npmAppSource = path.join(realJsonPath, "applications", "npm-nodejs");
    const npmAppDest = path.join(applicationsDir, "npm-nodejs");
    if (existsSync(npmAppSource)) {
      // Copy entire directory recursively
      copyDirectoryRecursive(npmAppSource, npmAppDest);
    }

    // Copy shared directory (templates and scripts) - npm-nodejs application references these
    const sharedSource = path.join(realJsonPath, "shared");
    const sharedDest = path.join(tempJsonDir, "shared");
    if (existsSync(sharedSource)) {
      copyDirectoryRecursive(sharedSource, sharedDest);
    }

    // Close existing instance if any
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }
    PersistenceManager.initialize(
      tempDir,
      storageContextFile,
      secretFile,
      false, // Disable cache for tests
      tempJsonDir, // Use test jsonPath
      path.join(repoRoot, "schemas"), // Use test schemaPath
    );
    const pm = PersistenceManager.getInstance();
    contextManager = pm.getContextManager();
    loader = new FrameworkLoader(
      {
        localPath: tempDir,
        jsonPath: tempJsonDir,
        schemaPath: path.join(repoRoot, "schemas"),
      },
      contextManager,
      pm.getPersistence(),
    );
  });

  function copyDirectoryRecursive(src: string, dest: string): void {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
      const srcPath = path.join(src, entry.name);
      const destPath = path.join(dest, entry.name);
      if (entry.isDirectory()) {
        copyDirectoryRecursive(srcPath, destPath);
      } else {
        copyFileSync(srcPath, destPath);
      }
    }
  }

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
    try {
      rmSync(tempJsonDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it("creates a valid application from framework", async () => {
    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "test-app",
      name: "Test Application",
      description: "A test application created from framework",
      parameterValues: [
        { id: "hostname", value: "test-app" },
        { id: "ostype", value: "alpine" },
        { id: "packages", value: "nodejs npm" },
        { id: "command", value: "test-command" },
        { id: "command_args", value: "--test" },
        { id: "package", value: "test-package" },
        { id: "owned_paths", value: "" },
        { id: "uid", value: "" },
        { id: "group", value: "" },
        { id: "username", value: "testuser" },
        { id: "volumes", value: "data=test" },
      ],
    };

    const applicationId = await loader.createApplicationFromFramework(request);
    expect(applicationId).toBe("test-app");

    // Verify application.json exists and is valid
    const appJsonPath = path.join(tempDir, "applications", "test-app", "application.json");
    expect(existsSync(appJsonPath)).toBe(true);

    const validator = PersistenceManager.getInstance().getJsonValidator();
    // Read and validate the application.json file
    // Note: The file should NOT contain 'id' - it's added when reading via persistence
    const appDataRaw = JSON.parse(fs.readFileSync(appJsonPath, "utf-8"));
    // Verify that 'id' is not in the file
    expect(appDataRaw).not.toHaveProperty("id");
    const appData = validator.serializeJsonFileWithSchema(appJsonPath, "application.schema.json") as IApplication;
    expect(appData.name).toBe("Test Application");
    expect(appData.description).toBe("A test application created from framework");
    expect(appData.extends).toBe("npm-nodejs");
    expect(Array.isArray(appData.installation)).toBe(true);
    // The first template should be derived from application-id
    // It may be a string or an object with {name, before}
    const firstTemplate = appData.installation?.[0];
    if (typeof firstTemplate === "string") {
      expect(firstTemplate).toBe("test-app-parameters.json");
    } else if (firstTemplate && typeof firstTemplate === "object") {
      expect((firstTemplate as any).name).toBe("test-app-parameters.json");
    } else {
      throw new Error(`Expected first template to be string or object, got ${typeof firstTemplate}`);
    }

    // Verify parameters template exists and is valid
    const setParamsPath = path.join(tempDir, "applications", "test-app", "templates", "test-app-parameters.json");
    expect(existsSync(setParamsPath)).toBe(true);

    const templateData = validator.serializeJsonFileWithSchema(setParamsPath, "template.schema.json") as ITemplate;
    expect(templateData.name).toBe("Set Parameters");
    expect(Array.isArray(templateData.commands)).toBe(true);
    expect(templateData.commands.length).toBeGreaterThan(0);
  });

  it("throws error if application already exists in localPath", async () => {
    // Create existing application directory
    const existingAppDir = path.join(tempDir, "applications", "existing-app");
    const existingAppJson = path.join(existingAppDir, "application.json");
    require("fs").mkdirSync(existingAppDir, { recursive: true });
    require("fs").writeFileSync(existingAppJson, JSON.stringify({ name: "Existing" }));

    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "existing-app",
      name: "Test Application",
      description: "A test application",
      parameterValues: [],
    };

    await expect(loader.createApplicationFromFramework(request)).rejects.toThrow(
      "already exists at",
    );
  });

  it("throws error if application already exists in jsonPath", async () => {
    // Create application in temp json directory to test the check
    const existingAppDir = path.join(tempJsonDir, "applications", "existing-json-app");
    const existingAppJson = path.join(existingAppDir, "application.json");
    mkdirSync(existingAppDir, { recursive: true });
    fs.writeFileSync(existingAppJson, JSON.stringify({ name: "Existing JSON App" }));

    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "npm-nodejs",
      applicationId: "existing-json-app",
      name: "Test Application",
      description: "A test application",
      parameterValues: [],
    };

    await expect(loader.createApplicationFromFramework(request)).rejects.toThrow(
      "already exists at",
    );
  });

  it("throws error for invalid framework", async () => {
    const request: IPostFrameworkCreateApplicationBody = {
      frameworkId: "non-existent-framework",
      applicationId: "test-app-invalid",
      name: "Test Application",
      description: "A test application",
      parameterValues: [],
    };

    await expect(loader.createApplicationFromFramework(request)).rejects.toThrow();
  });
});

