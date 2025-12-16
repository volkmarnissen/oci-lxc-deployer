#!/usr/bin/env node
import express from "express";
import {
  TaskType,
  ISsh,
  ApiUri,
  IUnresolvedParametersResponse,
  IApplicationsResponse,
  ISshConfigsResponse,
  ISshConfigKeyResponse,
  ISshCheckResponse,
  ISetSshConfigResponse,
  IDeleteSshConfigResponse,
} from "@src/types.mjs";
import http from "http";
import path from "path";
import { fileURLToPath } from "node:url";
import fs from "fs";
import { StorageContext } from "./storagecontext.mjs";
import { Ssh } from "./ssh.mjs";
import { IVEContext } from "./backend-types.mjs";
export class VEWebApp {
  app: express.Application;
  public httpServer: http.Server;
  returnResponse<T>(res: express.Response, payload: T, statusCode: number = 200) {
    res.status(statusCode).json(payload);
  }
  constructor(storageContext: StorageContext) {
    this.app = express();
    this.httpServer = http.createServer(this.app);
    // No socket.io needed anymore

    // Serve Angular static files (built frontend)
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = path.dirname(__filename);
    // fs imported from ESM above
    // Allow configuration via ENV or package.json
    // ENV has precedence: absolute or relative to repo root
    let configuredRel: string | undefined = process.env.LXC_MANAGER_FRONTEND_DIR;
    try {
      const rootPkg = path.join(__dirname, "../../package.json");
      if (fs.existsSync(rootPkg)) {
        const pkg = JSON.parse(fs.readFileSync(rootPkg, "utf-8"));
        if (pkg && pkg.lxcManager && pkg.lxcManager.frontendDir && !configuredRel) {
          configuredRel = String(pkg.lxcManager.frontendDir);
        }
      }
    } catch {}

    const repoRoot = path.join(__dirname, "../../");
    const candidates: string[] = [];
    if (configuredRel) {
      // support absolute or relative path
      candidates.push(path.isAbsolute(configuredRel) ? configuredRel : path.join(repoRoot, configuredRel));
    }
    // Fallbacks
    candidates.push(
      path.join(__dirname, "../../frontend/dist/webapp-angular/browser"),
      path.join(__dirname, "../../frontend/dist"),
      path.join(__dirname, "../../frontend/dist/frontend"),
      path.join(__dirname, "../webapp-angular"),
    );
    const staticDir = candidates.find((p) => {
      try {
        return fs.existsSync(p) && fs.statSync(p).isDirectory();
      } catch {
        return false;
      }
    });
    if (staticDir) {
      this.app.use(express.static(staticDir));
      this.app.get("/", (_req, res) => {
        res.sendFile(path.join(staticDir, "index.html"));
      });
    }

    // SSH config API
    this.app.get(ApiUri.SshConfigs, (req, res) => {
      try {
        const sshs: ISsh[] = storageContext.listSshConfigs();
        const key = storageContext.getCurrentVEContext()?.getKey();
        this.returnResponse<ISshConfigsResponse>(res, { sshs, key });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
    // Get SSH config key by host (mandatory path param)
    this.app.get(ApiUri.SshConfigGET, (req, res) => {
      try {
        const host = String(req.params.host || "").trim();
        if (!host) {
          res.status(400).json({ error: "Missing host" });
          return;
        }
        const key = `ve_${host}`;
        if (!storageContext.has(key)) {
          res.status(404).json({ error: "SSH config not found" });
          return;
        }
        this.returnResponse<ISshConfigKeyResponse>(res, { key });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    }); 
    // Check SSH permission for host/port
    this.app.get(ApiUri.SshCheck, (req, res) => {
      try {
        const host = String(req.query.host || "").trim();
        const portRaw = req.query.port as string | undefined;
        const port = portRaw ? Number(portRaw) : undefined;
        if (!host) {
          res.status(400).json({ error: "Missing host" });
          return;
        }
        const result = Ssh.checkSshPermission(host, port);
        this.returnResponse<ISshCheckResponse>(res, result);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    this.app.post(ApiUri.SshConfig, express.json(), (req, res) => {
      const body = req.body as Partial<ISsh> | undefined;
      const host = body?.host;
      const port = body?.port;
      const current = body?.current === true;
      // publicKeyCommand must never be persisted; ignore it from payload
      if (
        !host ||
        typeof host !== "string" ||
        typeof port !== "number"
      ) {
        res.status(400).json({
          error:
            "Invalid SSH config. Must provide host (string) and port (number).",
        });
        return;
      }
      try {
        // Add or update VE context
        var currentKey:string|undefined = storageContext.setVEContext({ host, port, current } as IVEContext);
        // If set as current, unset others
        if (current === true) {
          for (const key of storageContext.keys().filter((k) => k.startsWith("ve_") && k !== `ve_${host}`)) {
            const ctx: any = storageContext.get(key) || {};
            const updated = { ...ctx, current: false };
            storageContext.setVEContext(updated);
           }
         }
         else
          currentKey = undefined;
        this.returnResponse<ISetSshConfigResponse>(res, { success: true , key: currentKey });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Delete SSH config by host (port currently ignored in keying)
    this.app.delete(ApiUri.SshConfig, (req, res) => {
      try {
        const host = String(req.query.host || "").trim() || String((req.body as any)?.host || "").trim();
        if (!host) {
          res.status(400).json({ error: "Missing host" });
          return;
        }
        const key = `ve_${host}`;
        if (!storageContext.has(key)) {
          // Consider non-existent as success for idempotency
          this.returnResponse<IDeleteSshConfigResponse>(res, { success: true, deleted: false });
          return;
        }
        storageContext.remove(key);
        // If the removed one was current, set another VE as current (first found)
        const remainingKeys: string[] = storageContext.keys().filter((k: string) => k.startsWith("ve_"));
        var currentKey:string| undefined = undefined
        if (remainingKeys.length > 0 && remainingKeys[0] !== undefined) {
          // Choose first and mark as current
          currentKey = remainingKeys[0];
          const ctx: any = storageContext.get(currentKey) || {};
          const updated = { ...ctx, current: true };
          storageContext.set(currentKey, updated);
        }
        this.returnResponse<IDeleteSshConfigResponse>(res, { success: true, deleted: true, key: currentKey });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // Set an existing SSH config as current (by host). Unset others.
    this.app.put(ApiUri.SshConfig, express.json(), (req, res) => {
      try {
        const rawHost = (req.query.host as string | undefined) ?? (req.body as any)?.host as string | undefined;
        const host = rawHost ? String(rawHost).trim() : "";
        if (!host) {
          res.status(400).json({ error: "Missing host" });
          return;
        }
        const key: string = `ve_${host}`;
        if (!storageContext.has(key)) {
          res.status(404).json({ error: "SSH config not found" });
          return;
        }
        // Unset current for all others
        for (const k of storageContext.keys().filter((k: string) => k.startsWith("ve_") && k !== key)) {
          const ctx: any = storageContext.get(k) || {};
          storageContext.set(k, { ...ctx, current: false });
        }
        // Set this one as current
        const curCtx: any = storageContext.get(key) || {};
        storageContext.set(key, { ...curCtx, current: true });
        this.returnResponse<ISetSshConfigResponse>(res, { success: true , key });
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });

    // GET /api/unresolved-parameters/:application/:task?veContext=<key>
    this.app.get(ApiUri.UnresolvedParameters, async (req, res) => {
      try {
        const { application, task } = req.params;
        const veContextKey = (req.query.veContext as string | undefined) || undefined;
        if (!veContextKey) {
          return res.status(400).json({ success: false, error: "Missing veContext" });
        }
        const storageContext = StorageContext.getInstance();
        const ctx: IVEContext | null = storageContext.getVEContextByKey(veContextKey);
        if (!ctx) {
          return res.status(404).json({ success: false, error: "VE context not found" });
        }
        const templateProcessor = storageContext.getTemplateProcessor();
        const loaded = templateProcessor.loadApplication(
          application,
          task as TaskType,
          ctx
        );
        const unresolved = templateProcessor.getUnresolvedParameters(
          loaded.parameters,
          loaded.resolvedParams,
        );
        this.returnResponse<IUnresolvedParametersResponse>(res, { unresolvedParameters: unresolved });
      } catch (err: any) {
        return res
          .status(500)
          .json({ success: false, error: err?.message || "Unknown error" });
      }
    });
    this.app.get(ApiUri.Applications, (req, res) => {
      try {
        const applications = storageContext.listApplications();
        const payload: IApplicationsResponse = applications;
        res.json(payload).status(200);
      } catch (err: any) {
        res.status(500).json({ error: err.message });
      }
    });
  }
}

// If run directly, start the server
if (
  import.meta.url === process.argv[1] ||
  import.meta.url === `file://${process.argv[1]}`
) {
  const filename = fileURLToPath(import.meta.url);
  const dirname = path.dirname(filename);
  // Do NOT change working directory; respect caller's CWD.
  // Support --local <dir> CLI option to set the local directory
  // Default is './local' relative to current working directory
  const argv = process.argv.slice(2);
  let localDir: string | undefined;
  const localIdx = argv.indexOf("--local");
  if (localIdx !== -1) {
    const candidateArg = argv[localIdx + 1] || "";
    const candidate = String(candidateArg);
    if (candidate.length > 0) {
      localDir = path.isAbsolute(candidate)
        ? candidate
        : path.join(process.cwd(), candidate);
    }
  }
  if (!localDir) {
    localDir = path.join(process.cwd(), "local");
  }

  // Initialize StorageContext with absolute paths to avoid CWD-dependency
  StorageContext.setInstance( localDir);
  const webApp = new VEWebApp(StorageContext.getInstance());
  const port = process.env.PORT || 3000;
  webApp.httpServer.listen(port, () => {
    console.log(`VEWebApp listening on port ${port}`);
  });
}
