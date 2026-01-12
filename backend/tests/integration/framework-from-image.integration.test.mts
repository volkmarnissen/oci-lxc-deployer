import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { IVEContext } from "@src/backend-types.mjs";
import { IOciImageAnnotations } from "@src/types.mjs";
import { execSync } from "child_process";
import path from "path";
import { fileURLToPath } from "node:url";
import fs from "fs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { ExecutionMode } from "@src/ve-execution-constants.mjs";
import { FrameworkFromImage } from "@src/framework-from-image.mjs";

// Check if skopeo is available (synchronously at module load time)
let skopeoAvailable = false;
try {
  execSync("which skopeo", { stdio: "ignore" });
  skopeoAvailable = true;
} catch {
  skopeoAvailable = false;
}

describe("FrameworkFromImage - Integration Tests", () => {
  const localhostVEContext: IVEContext = {
    host: "localhost",
    port: 22,
    getKey: () => "ve_localhost",
    getStorageContext: () => null,
  } as IVEContext;

  // Get script path (integration tests are in tests/integration/, so go up 3 levels to repo root)
  const __filename = fileURLToPath(import.meta.url);
  const integrationTestDir = path.dirname(__filename);
  const testsDir = path.dirname(integrationTestDir);
  const backendDir = path.dirname(testsDir);
  const repoRoot = path.dirname(backendDir);
  const scriptPath = path.join(
    repoRoot,
    "json/shared/scripts/get-oci-image-annotations.py",
  );

  describe("getAnnotationsFromImage - ungemockt (localhost)", () => {
    // Only run if skopeo is available
    const testIfSkopeo = skopeoAvailable ? it : it.skip;

    beforeAll(() => {
      // Initialize PersistenceManager with real json path for ungemockt tests
      const __filename = fileURLToPath(import.meta.url);
      // Integration tests are in tests/integration/, so we need to go up 3 levels to get to repo root
      const integrationTestDir = path.dirname(__filename);
      const testsDir = path.dirname(integrationTestDir);
      const backendDir = path.dirname(testsDir);
      const repoRoot = path.dirname(backendDir);
      const jsonDir = path.join(repoRoot, "json");
      const schemasDir = path.join(repoRoot, "schemas");
      const testDir = mkdtempSync(path.join(tmpdir(), "framework-from-image-ungemockt-"));
      const storageContextPath = path.join(testDir, "storagecontext.json");
      const secretFilePath = path.join(testDir, "secret.txt");
      writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");
      writeFileSync(secretFilePath, "", "utf-8");

      // Close existing instance if any
      try {
        PersistenceManager.getInstance().close();
      } catch {
        // Ignore if not initialized
      }

      PersistenceManager.initialize(
        path.join(testDir, "local"),
        storageContextPath,
        secretFilePath,
        false, // Disable cache for tests
        jsonDir, // Use real json path
        schemasDir, // Use real schemas path
      );
    });

    afterAll(() => {
      try {
        PersistenceManager.getInstance().close();
      } catch {
        // Ignore if not initialized
      }
    });

    testIfSkopeo("should extract annotations from home-assistant image (GitHub Container Registry)", async () => {
      // Check if script exists
      if (!fs.existsSync(scriptPath)) {
        throw new Error(`Script not found: ${scriptPath}`);
      }

      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "ghcr.io/home-assistant/home-assistant",
        "latest",
        ExecutionMode.TEST,
      );

      // Home Assistant should have at least some annotations
      // Check that at least one annotation is defined
      const hasAnnotation =
        annotations.url !== undefined ||
        annotations.documentation !== undefined ||
        annotations.source !== undefined ||
        annotations.vendor !== undefined ||
        annotations.description !== undefined;

      expect(hasAnnotation).toBe(true);

      // If source is defined, it should be a valid URL
      if (annotations.source) {
        expect(annotations.source).toMatch(/^https?:\/\//);
      }
    }, 60000); // 60 second timeout for network requests

    testIfSkopeo("should extract annotations from mariadb image (Docker Hub)", async () => {
      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "mariadb",
        "latest",
        ExecutionMode.TEST,
      );

      // MariaDB should have at least some annotations
      const hasAnnotation =
        annotations.url !== undefined ||
        annotations.documentation !== undefined ||
        annotations.source !== undefined ||
        annotations.vendor !== undefined ||
        annotations.description !== undefined;

      expect(hasAnnotation).toBe(true);
    }, 60000);

    testIfSkopeo("should extract annotations from ghcr.io image (GitHub Container Registry)", async () => {
      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "ghcr.io/home-assistant/home-assistant",
        "latest",
        ExecutionMode.TEST,
      );

      // GitHub images should have at least source annotation
      const hasAnnotation =
        annotations.url !== undefined ||
        annotations.documentation !== undefined ||
        annotations.source !== undefined ||
        annotations.vendor !== undefined ||
        annotations.description !== undefined;

      expect(hasAnnotation).toBe(true);

      // GitHub images typically have source pointing to GitHub
      if (annotations.source) {
        expect(annotations.source).toMatch(/github\.com/);
      }

      // Home Assistant should have specific annotations
      expect(annotations.url).toBe("https://www.home-assistant.io/");
      expect(annotations.documentation).toBe("https://www.home-assistant.io/docs/");
      expect(annotations.source).toBe("https://github.com/home-assistant/core");
    }, 60000);

    testIfSkopeo("should extract annotations from docker.io image (explicit Docker Hub)", async () => {
      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "nodered/node-red",
        "latest",
        ExecutionMode.TEST,
      );

      // Node-RED should have at least some annotations
      const hasAnnotation =
        annotations.url !== undefined ||
        annotations.documentation !== undefined ||
        annotations.source !== undefined ||
        annotations.vendor !== undefined ||
        annotations.description !== undefined;

      expect(hasAnnotation).toBe(true);
    }, 60000);
  });
});

