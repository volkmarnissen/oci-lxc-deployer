import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { FrameworkLoader } from "@src/frameworkloader.mjs";
import { VEConfigurationError, IVEContext } from "@src/backend-types.mjs";

describe("FrameworkLoader", () => {
  let tempDir: string;
  let loader: FrameworkLoader;
  let contextManager: ReturnType<typeof PersistenceManager.getInstance>["getContextManager"];

  beforeAll(() => {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, "..", "..");
    tempDir = mkdtempSync(path.join(os.tmpdir(), "lxc-fw-"));
    const storageContextFile = path.join(tempDir, "storagecontext.json");
    const secretFile = path.join(tempDir, "secret.txt");

    // Close existing instance if any
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }
    PersistenceManager.initialize(
      path.join(repoRoot, "local"),
      storageContextFile,
      secretFile,
    );
    const pm = PersistenceManager.getInstance();
    contextManager = pm.getContextManager();
    loader = new FrameworkLoader(
      {
        localPath: path.join(repoRoot, "local"),
        jsonPath: path.join(repoRoot, "json"),
        schemaPath: path.join(repoRoot, "schemas"),
      },
      contextManager,
    );
  });

  afterAll(() => {
    // Cleanup
    try {
      if (tempDir) {
        rmSync(tempDir, { recursive: true, force: true });
      }
    } catch {
      // Ignore cleanup errors
    }
  });

  it(
    "should load framework and get parameters",
    async () => {
      const framework = loader.readFrameworkJson("npm-nodejs", {
        error: new VEConfigurationError("", "npm-nodejs"),
      });
      const veContext: IVEContext = {
        host: "validation-dummy",
        getStorageContext: () => contextManager as any,
        getKey: () => "ve_validation",
      };

      // getParameters can be slow due to:
      // - Template processing (loadApplication)
      // - Script validation (may attempt SSH connections with retries)
      // - File system operations
      const parameters = await loader.getParameters(
        "npm-nodejs",
        "installation",
        veContext,
      );
      expect(parameters.length).toBe(framework.properties.length);
      for (const param of parameters) {
        expect(param.required).toBe(true);
        expect((param as any).advanced).toBeUndefined();
      }
    },
    60000, // 60 second timeout - getParameters can be slow due to template processing and SSH retries
  );
});

