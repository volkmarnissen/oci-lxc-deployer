import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { IVEContext } from "@src/backend-types.mjs";
import { ExecutionMode } from "@src/ve-execution-constants.mjs";
import { FrameworkFromImage } from "@src/framework-from-image.mjs";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import path from "path";
import { fileURLToPath } from "node:url";
import fs from "fs";

/**
 * Quick integration test for FrameworkFromImage.getAnnotationsFromImage.
 * 
 * This test verifies that the script integration works correctly by:
 * - Testing with a non-existent image (should throw "not found" error quickly)
 * - Testing with an existing image (should return annotations after fast existence check)
 * 
 * The script automatically checks image existence first (fast --raw check),
 * then performs full inspection if the image exists.
 * 
 * This test is fast (< 15 seconds) and can run with regular unit tests.
 * It uses ExecutionMode.TEST to run locally (requires skopeo to be installed).
 */
describe("FrameworkFromImage - Quick Integration Test", () => {
  const localhostVEContext: IVEContext = {
    host: "localhost",
    port: 22,
    getKey: () => "ve_localhost",
    getStorageContext: () => null,
  } as IVEContext;

  // Check if skopeo is available (synchronous check)
  const skopeoAvailable = (() => {
    try {
      const { execSync } = require("child_process");
      execSync("which skopeo", { stdio: "ignore" });
      execSync("skopeo --version", { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  })();

  beforeAll(() => {
    // Initialize PersistenceManager with real paths
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    const repoRoot = path.resolve(__dirname, "..", "..");
    const jsonPath = path.join(repoRoot, "json");
    const schemasPath = path.join(repoRoot, "schemas");
    const localPath = path.join(repoRoot, "local");
    const storageContextPath = path.join(localPath, "storagecontext.json");
    const secretFilePath = path.join(localPath, "secret.txt");

    // Ensure directories exist
    if (!fs.existsSync(storageContextPath)) {
      fs.mkdirSync(path.dirname(storageContextPath), { recursive: true });
      fs.writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");
    }
    if (!fs.existsSync(secretFilePath)) {
      fs.writeFileSync(secretFilePath, "", "utf-8");
    }

    // Close existing instance if any
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }

    PersistenceManager.initialize(
      localPath,
      storageContextPath,
      secretFilePath,
      false, // Disable cache for tests
      jsonPath,
      schemasPath,
    );
  });

  afterAll(() => {
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }
  });

  (skopeoAvailable ? it : it.skip)(
    "should quickly return 404 for non-existent image",
    { timeout: 5000 }, // 5 second timeout for quick check
    async () => {
      await expect(
        FrameworkFromImage.getAnnotationsFromImage(
          localhostVEContext,
          "this-image-definitely-does-not-exist-12345",
          "latest",
          ExecutionMode.TEST,
        ),
      ).rejects.toThrow("not found");
    },
  );

  (skopeoAvailable ? it : it.skip)(
    "should successfully get annotations for existing image (alpine:latest)",
    { timeout: 15000 }, // 15 second timeout (includes fast check + full inspection)
    async () => {
      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "alpine",
        "latest",
        ExecutionMode.TEST,
      );

      // Alpine may not have annotations, but should not throw "not found"
      expect(annotations).toBeDefined();
      expect(typeof annotations).toBe("object");
    },
  );
});

