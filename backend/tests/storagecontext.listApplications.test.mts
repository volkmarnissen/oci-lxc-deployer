import { describe, it, expect, beforeEach } from "vitest";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";

function createTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oci-lxc-deployer-test-"));
  // Ensure required directories exist
  fs.mkdirSync(path.join(dir, "json"), { recursive: true });
  fs.mkdirSync(path.join(dir, "schemas"), { recursive: true });
  return dir;
}

describe("StorageContext.listApplications", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = createTempDir();
    const storageContextFile = path.join(tmp, "storagecontext.json");
    const secretFile = path.join(tmp, "secret.txt");
    // Close existing instance if any
    try {
      PersistenceManager.getInstance().close();
    } catch {
      // Ignore if not initialized
    }
    PersistenceManager.initialize(tmp, storageContextFile, secretFile);
  });

  it("returns more than one application and first has name/description", () => {
    const pm = PersistenceManager.getInstance();
    const apps = pm.getApplicationService().listApplicationsForFrontend();

    expect(Array.isArray(apps)).toBe(true);
    expect(apps.length).toBeGreaterThan(1);

    const first = apps[0] as any;
    expect(typeof first?.name).toBe("string");
    expect((first?.name as string).length).toBeGreaterThan(0);
    expect(typeof first?.description).toBe("string");
    expect((first?.description as string).length).toBeGreaterThan(0);
  });
});
