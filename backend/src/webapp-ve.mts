import { IVEContext, IVMContext } from "./backend-types.mjs";
import { StorageContext } from "./storagecontext.mjs";

import express, { RequestHandler } from "express";
import fs from "fs";
import path from "path";
import {
  ApiUri,
  IVeExecuteMessage,
  TaskType,
  IVeConfigurationResponse,
  IVeExecuteMessagesResponse,
  IPostVeConfigurationBody,
} from "./types.mjs";
import { IRestartInfo, VeExecution } from "./ve-execution.mjs";

export class WebAppVE {
  messages: IVeExecuteMessagesResponse = [];
  private restartInfos: Map<string, IRestartInfo> = new Map();
  returnResponse<T>(
    res: express.Response,
    payload: T,
    statusCode: number = 200,
  ) {
    res.status(statusCode).json(payload);
  }

  private post<
    TParams extends Record<string, string>,
    TBody,
    TQuery extends Record<string, string | undefined> = Record<string, string | undefined>
  >(
    path: string,
    handler: (
      req: express.Request<TParams, unknown, TBody, TQuery>,
      res: express.Response
    ) => void | Promise<unknown>
  ): void {
    this.app.post(path, express.json(), handler as unknown as RequestHandler);
  }

  constructor(private app: express.Application) {}
  init() {
    // Initialize VE specific web app features here
    // POST /api/proxmox-configuration/:application/:task
    this.post<
      { application: string; task: string; veContext: string },
      IPostVeConfigurationBody,
      { restartKey?: string }
    >(ApiUri.VeConfiguration, async (req, res) => {
      const { application, task, veContext: veContextKey } = req.params;
      const restartKeyParam = req.query.restartKey;
      const { params } = req.body;
      if (!Array.isArray(params)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid parameters" });
      }
      try {
        // 1. Save configuration in local/<application>.config.json
        const localDir = path.join(process.cwd(), "local");
        if (!fs.existsSync(localDir)) fs.mkdirSync(localDir);
        const configPath = path.join(localDir, `${application}.config.json`);
        fs.writeFileSync(configPath, JSON.stringify(params, null, 2), "utf-8");

        // 2. Load application (provides commands)
        const storageContext = StorageContext.getInstance();
        const ctx: IVEContext | null =
          storageContext.getVEContextByKey(veContextKey);
        if (!ctx) {
          return res
            .status(404)
            .json({ success: false, error: "VE context not found" });
        }
        const veCtxToUse: IVEContext = ctx as IVEContext;
        const templateProcessor = veCtxToUse
          .getStorageContext()
          .getTemplateProcessor();
        const loaded = await templateProcessor.loadApplication(
          application,
          task as TaskType,
          veCtxToUse,
        );
        const commands = loaded.commands;
        const defaults = new Map<string, string | number | boolean>();
        loaded.parameters.forEach((param) => {
          const p = defaults.get(param.name);
          if (!p && param.default !== undefined) {
            // do not overwrite existing defaults
            defaults.set(param.id, param.default);
          }
        });
        // 3. Start ProxmoxExecution
        const inputs = params.map(p => ({ id: p.name, value: p.value }));
        const exec = new VeExecution(commands, inputs, veCtxToUse, defaults);
        exec.on("message", (msg: IVeExecuteMessage) => {
          const existing = this.messages.find(
            (g) => g.application === application && g.task === task,
          );
          if (existing) {
            existing.messages.push(msg);
          } else {
            this.messages.push({ application, task, messages: [msg] });
          }
        });
        exec.on("finished", (msg: IVMContext) => {
          veCtxToUse.getStorageContext().setVMContext(msg);
        });
        this.messages = [];
        let restartInfoToUse: IRestartInfo | undefined = undefined;
        if (restartKeyParam) {
          const stored = this.restartInfos.get(restartKeyParam);
          if (stored) restartInfoToUse = stored;
        }
        
        // Respond immediately, run execution in background
        this.returnResponse<IVeConfigurationResponse>(res, { success: true });
        
        // Run asynchronously - now non-blocking thanks to async spawn
        exec.run(restartInfoToUse).then((result) => {
          if (result) {
            const key = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
            this.restartInfos.set(key, result);
          }
        }).catch((err: Error) => {
          console.error("Execution error:", err.message);
        });
      } catch (err: any) {
        res
          .status(500)
          .json({ success: false, error: err.message || "Unknown error" });
      }
    });
    // GET /api/ProxmoxExecuteMessages: dequeues all messages in the queue and returns them
    this.app.get(ApiUri.VeExecute, (req, res) => {
      this.returnResponse<IVeExecuteMessagesResponse>(res, this.messages);
    });
  }
}
