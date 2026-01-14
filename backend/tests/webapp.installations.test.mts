import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { VEWebApp } from "@src/webapp.mjs";
import express from "express";
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { PersistenceManager } from "@src/persistence/persistence-manager.mjs";
import { ApiUri, TaskType } from "@src/types.mjs";

function mkTmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function mkDirs(root: string, ...dirs: string[]): void {
  for (const d of dirs) fs.mkdirSync(path.join(root, d), { recursive: true });
}

describe("WebApp Installations API", () => {
  let app: express.Application;
  let tmpLocal: string;
  let tmpJson: string;
  let tmpSchemas: string;

  beforeEach(() => {
    tmpLocal = mkTmpDir("lxc-local-");
    tmpJson = mkTmpDir("lxc-json-");
    tmpSchemas = mkTmpDir("lxc-schemas-");
    // Ensure json/schemas dirs exist but stay empty (no project json usage)
    mkDirs(tmpJson);
    mkDirs(tmpSchemas);

    const storageContextFile = path.join(tmpLocal, "storagecontext.json");
    const secretFile = path.join(tmpLocal, "secret.txt");

    // Reset singleton between tests
    try { PersistenceManager.getInstance().close(); } catch {}

    // Initialize with dedicated local/json/schemas paths
    PersistenceManager.initialize(
      tmpLocal,
      storageContextFile,
      secretFile,
      true,
      tmpJson,
      tmpSchemas,
    );

    const ctx = PersistenceManager.getInstance().getContextManager();
    // Seed two VMInstall contexts, without touching json dir
    ctx.setVMInstallContext({
      hostname: "cont-01",
      application: "app-alpha",
      task: "installation" as TaskType,
      changedParams: [],
    });
    ctx.setVMInstallContext({
      hostname: "cont-02",
      application: "app-beta",
      task: "installation" as TaskType,
      changedParams: [],
    });

    app = new VEWebApp(ctx as any).app;
  });

  it("returns two installations without errors and does not modify json dir", async () => {
    // json dir should remain empty (no files written)
    const jsonFilesBefore = fs.readdirSync(tmpJson);
    expect(jsonFilesBefore.length).toBe(0);

    const res = await request(app).get(ApiUri.Installations);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(2);

    // Validate shape of entries
    for (const entry of res.body) {
      expect(typeof entry.vmInstallKey).toBe("string");
      expect(entry.vmInstallKey.startsWith("vminstall_")).toBe(true);
      expect(typeof entry.hostname).toBe("string");
      expect(typeof entry.task).toBe("string");
      // application fallback when app metadata not present
      expect(entry.application && typeof entry.application.id).toBe("string");
      expect(entry.application && typeof entry.application.name).toBe("string");
    }

    // Still no json written afterwards
    const jsonFilesAfter = fs.readdirSync(tmpJson);
    expect(jsonFilesAfter.length).toBe(0);
  });
});
