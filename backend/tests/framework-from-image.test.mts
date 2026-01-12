import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { IVEContext } from "@src/backend-types.mjs";
import { IOciImageAnnotations } from "@src/types.mjs";
import path from "path";
import fs from "fs";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { ExecutionMode } from "@src/ve-execution-constants.mjs";
import { FrameworkFromImage } from "@src/framework-from-image.mjs";

describe("FrameworkFromImage", () => {
  const localhostVEContext: IVEContext = {
    host: "localhost",
    port: 22,
    getKey: () => "ve_localhost",
    getStorageContext: () => null,
  } as IVEContext;

  describe("buildFrameworkFromAnnotations", () => {
    it("should build framework from annotations", () => {
      const annotations: IOciImageAnnotations = {
        url: "https://www.home-assistant.io/",
        documentation: "https://www.home-assistant.io/docs/",
        source: "https://github.com/home-assistant/core",
        vendor: "Home Assistant",
        description: "Open source home automation",
      };

      const framework = FrameworkFromImage.buildFrameworkFromAnnotations(
        "home-assistant/home-assistant",
        annotations,
      );

      expect(framework.name).toBe("Home Assistant");
      expect(framework.extends).toBe("npm-nodejs");
      expect(framework.url).toBe("https://www.home-assistant.io/");
      expect(framework.documentation).toBe("https://www.home-assistant.io/docs/");
      expect(framework.source).toBe("https://github.com/home-assistant/core");
      expect(framework.vendor).toBe("Home Assistant");
      expect(framework.description).toBe("Open source home automation");
    });

    it("should handle partial annotations", () => {
      const annotations: IOciImageAnnotations = {
        source: "https://github.com/test/repo",
      };

      const framework = FrameworkFromImage.buildFrameworkFromAnnotations(
        "test/image",
        annotations,
      );

      expect(framework.name).toBe("Image");
      expect(framework.extends).toBe("npm-nodejs");
      expect(framework.source).toBe("https://github.com/test/repo");
      expect(framework.url).toBeUndefined();
      expect(framework.documentation).toBeUndefined();
    });

    it("should handle image names with slashes", () => {
      const annotations: IOciImageAnnotations = {
        description: "Test description",
      };

      const framework = FrameworkFromImage.buildFrameworkFromAnnotations(
        "ghcr.io/home-assistant/home-assistant",
        annotations,
      );

      expect(framework.name).toBe("Home Assistant");
      expect(framework.description).toBe("Test description");
    });
  });

  // Integration tests have been moved to framework-from-image.integration.test.mts
  // They are excluded from regular test runs and can be run with: npm run test:integration

  describe("getAnnotationsFromImage - gemockt", () => {
    let testDir: string;
    let mockJsonPath: string;
    let mockScriptPath: string;
    let storageContextPath: string;
    let secretFilePath: string;

    beforeEach(() => {
      // Create temporary directory for mock scripts
      testDir = mkdtempSync(path.join(tmpdir(), "framework-from-image-mock-"));
      mockJsonPath = path.join(testDir, "json");
      const scriptsDir = path.join(mockJsonPath, "shared", "scripts");
      mkdirSync(scriptsDir, { recursive: true });
      
      // Create schemas directory (required by PersistenceManager)
      const schemasDir = path.join(testDir, "schemas");
      mkdirSync(schemasDir, { recursive: true });
      
      mockScriptPath = path.join(scriptsDir, "get-oci-image-annotations.py");
      
      storageContextPath = path.join(testDir, "storagecontext.json");
      secretFilePath = path.join(testDir, "secret.txt");
      writeFileSync(storageContextPath, JSON.stringify({}), "utf-8");
      writeFileSync(secretFilePath, "", "utf-8");

      // Close existing instance if any
      try {
        PersistenceManager.getInstance().close();
      } catch {
        // Ignore if not initialized
      }

      // Initialize PersistenceManager with mock jsonPath
      PersistenceManager.initialize(
        path.join(testDir, "local"),
        storageContextPath,
        secretFilePath,
        false, // Disable cache for tests
        mockJsonPath, // Use mock jsonPath
        schemasDir, // schemaPath
      );
    });

    afterEach(() => {
      try {
        PersistenceManager.getInstance().close();
      } catch {
        // Ignore if not initialized
      }
      if (testDir && fs.existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
    });

    it("should extract annotations with mocked script (home-assistant)", async () => {
      const mockAnnotations: IOciImageAnnotations = {
        url: "https://www.home-assistant.io/",
        documentation: "https://www.home-assistant.io/docs/",
        source: "https://github.com/home-assistant/core",
        vendor: "Home Assistant",
        description: "Open source home automation that puts local control and privacy first.",
      };

      // Create mock script that outputs JSON
      const mockScript = `#!/usr/bin/env python3
import json
import sys

# Output mock annotations as JSON
output = ${JSON.stringify(mockAnnotations, null, 2)}
print(json.dumps(output))
`;
      writeFileSync(mockScriptPath, mockScript, { mode: 0o755 });

      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "home-assistant/home-assistant",
        "latest",
        ExecutionMode.TEST,
      );

      expect(annotations).toEqual(mockAnnotations);
      expect(annotations.url).toBeDefined();
      expect(annotations.documentation).toBeDefined();
      expect(annotations.source).toBeDefined();
      expect(annotations.vendor).toBeDefined();
      expect(annotations.description).toBeDefined();
    });

    it("should extract annotations with mocked script (mariadb)", async () => {
      const mockAnnotations: IOciImageAnnotations = {
        source: "https://github.com/MariaDB/mariadb-docker",
        description: "MariaDB Server is a high performing open source relational database",
      };

      const mockScript = `#!/usr/bin/env python3
import json
import sys

output = ${JSON.stringify(mockAnnotations, null, 2)}
print(json.dumps(output))
`;
      writeFileSync(mockScriptPath, mockScript, { mode: 0o755 });

      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "mariadb",
        "latest",
        ExecutionMode.TEST,
      );

      expect(annotations).toEqual(mockAnnotations);
      expect(annotations.source).toBeDefined();
      expect(annotations.description).toBeDefined();
    });

    it("should extract annotations with mocked script (ghcr.io)", async () => {
      const mockAnnotations: IOciImageAnnotations = {
        source: "https://github.com/home-assistant/core",
        description: "Home Assistant Core",
      };

      const mockScript = `#!/usr/bin/env python3
import json
import sys

output = ${JSON.stringify(mockAnnotations, null, 2)}
print(json.dumps(output))
`;
      writeFileSync(mockScriptPath, mockScript, { mode: 0o755 });

      const annotations = await FrameworkFromImage.getAnnotationsFromImage(
        localhostVEContext,
        "ghcr.io/home-assistant/home-assistant",
        "latest",
        ExecutionMode.TEST,
      );

      expect(annotations).toEqual(mockAnnotations);
      expect(annotations.source).toBeDefined();
      expect(annotations.description).toBeDefined();
    });

    it("should handle script errors gracefully", async () => {
      // Create mock script that exits with error
      const mockScript = `#!/usr/bin/env python3
import sys
print("Error: Connection refused", file=sys.stderr)
sys.exit(1)
`;
      writeFileSync(mockScriptPath, mockScript, { mode: 0o755 });

      await expect(
        FrameworkFromImage.getAnnotationsFromImage(
          localhostVEContext,
          "test/image",
          "latest",
          ExecutionMode.TEST,
        ),
      ).rejects.toThrow();
    });

    it("should handle invalid JSON output", async () => {
      // Create mock script that outputs invalid JSON
      const mockScript = `#!/usr/bin/env python3
print("Invalid JSON")
`;
      writeFileSync(mockScriptPath, mockScript, { mode: 0o755 });

      await expect(
        FrameworkFromImage.getAnnotationsFromImage(
          localhostVEContext,
          "test/image",
          "latest",
          ExecutionMode.TEST,
        ),
      ).rejects.toThrow("Failed to parse JSON");
    });
  });
});

