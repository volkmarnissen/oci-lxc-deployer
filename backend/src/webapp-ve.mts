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
  ISingleExecuteMessagesResponse,
  IPostVeConfigurationBody,
} from "./types.mjs";
import { IRestartInfo, VeExecution } from "./ve-execution.mjs";

const MESSAGE_RETENTION_MS = 30 * 60 * 1000; // 30 minutes

export class WebAppVE {
  messages: IVeExecuteMessagesResponse = [];
  private restartInfos: Map<string, IRestartInfo> = new Map();
  private messageTimestamps: Map<string, number> = new Map(); // key: "app/task"

  private cleanupOldMessages() {
    const now = Date.now();
    const keysToRemove: string[] = [];
    this.messageTimestamps.forEach((timestamp, key) => {
      if (now - timestamp > MESSAGE_RETENTION_MS) {
        keysToRemove.push(key);
      }
    });
    for (const key of keysToRemove) {
      const [app, task] = key.split("/");
      this.messages = this.messages.filter(
        (g) => !(g.application === app && g.task === task),
      );
      this.messageTimestamps.delete(key);
    }
  }

  /**
   * Finds or creates a message group for the given application and task.
   */
  private findOrCreateMessageGroup(
    application: string,
    task: string,
    restartKey: string,
  ): ISingleExecuteMessagesResponse {
    let existing = this.messages.find(
      (g) => g.application === application && g.task === task,
    );
    if (!existing) {
      existing = {
        application,
        task,
        messages: [],
        restartKey,
      };
      this.messages.push(existing);
    }
    return existing;
  }

  /**
   * Updates the error state of a message based on exitCode and error flag.
   */
  private updateErrorState(
    existingMsg: IVeExecuteMessage,
    msg: IVeExecuteMessage,
  ): void {
    // Update exitCode if provided
    if (msg.exitCode !== undefined) {
      existingMsg.exitCode = msg.exitCode;
      // Reset error flag if exitCode is 0 (success)
      if (msg.exitCode === 0) {
        existingMsg.error = undefined;
      }
    }
    // Always update error flag from msg (even if undefined, to clear old errors)
    // This ensures that partial messages without errors clear the error state
    existingMsg.error = msg.error;
  }

  /**
   * Handles a partial message by appending to an existing message.
   * Returns true if the message was handled, false otherwise.
   */
  private handlePartialMessage(
    msg: IVeExecuteMessage,
    existing: ISingleExecuteMessagesResponse,
  ): boolean {
    if (msg.partial !== true) {
      return false;
    }

    // Check index once
    if (msg.index !== undefined) {
      // Try to find existing message by index
      const existingMsg = existing.messages.find(m => m.index === msg.index);
      if (existingMsg) {
        // Append stderr/stdout to existing message
        existingMsg.stderr = (existingMsg.stderr || "") + (msg.stderr || "");
        if (msg.result) {
          existingMsg.result = (existingMsg.result || "") + (msg.result || "");
        }
        this.updateErrorState(existingMsg, msg);
        return true; // Message handled
      }
    } else {
      // If index is undefined, all existing commands were successful
      // Mark all existing messages as final (all commands were successful)
      for (let i = existing.messages.length - 1; i >= 0; i--) {
        existing.messages[i]!.partial = false;
        existing.messages[i]!.error = undefined;
        existing.messages[i]!.exitCode = 0;
        // Try to append to last message with same command name
        const lastMsg = existing.messages[i];
        if (lastMsg && lastMsg.command === msg.command) {
          // Append stderr/stdout to last message
          lastMsg.stderr = (lastMsg.stderr || "") + (msg.stderr || "");
          if (msg.result) {
            lastMsg.result = (lastMsg.result || "") + (msg.result || "");
          }
        }
        return true; // Message handled
      }
    }

    return false; // Not handled as partial
  }

  /**
   * Handles a final (non-partial) message by replacing or updating an existing message.
   * Returns true if the message was handled, false otherwise.
   */
  private handleFinalMessage(
    msg: IVeExecuteMessage,
    existing: ISingleExecuteMessagesResponse,
  ): boolean {
    if (msg.partial === true) {
      return false;
    }

    // Only handle if message has an index and an existing message with that index exists
    if (msg.index !== undefined) {
      const existingMsg = existing.messages.find(m => m.index === msg.index);
      if (existingMsg) {
        // Replace existing message with final values
        const index = existing.messages.indexOf(existingMsg);
        if (index >= 0) {
          existing.messages[index] = {
            ...existingMsg,
            ...msg,
            // Preserve accumulated stderr/result from partial messages
            stderr: (existingMsg.stderr || "") + (msg.stderr || ""),
            result: msg.result || existingMsg.result,
            // Reset error flag if exitCode is 0 (success)
            error: msg.exitCode === 0 ? undefined : (msg.error !== undefined ? msg.error : existingMsg.error),
          };
        }
        return true; // Message handled
      }
      
      // If no message with this index exists, mark all messages with lower index as final
      // This handles the case where partial messages without index were appended to previous messages
      for (const existingMsg of existing.messages) {
        if (existingMsg.index !== undefined && existingMsg.index < msg.index) {
          existingMsg.partial = false;
          // If exitCode is still -1 (from partial messages), set it to 0 (success) if the final message succeeded
          if (existingMsg.exitCode === -1 && msg.exitCode === 0) {
            existingMsg.exitCode = 0;
            existingMsg.error = undefined;
          }
        }
      }
    }

    return false; // Not handled as final
  }

  /**
   * Handles incoming execution messages and updates the messages array.
   * Merges partial messages with existing ones and handles final message updates.
   */
  private handleExecutionMessage(
    msg: IVeExecuteMessage,
    application: string,
    task: string,
    restartKey: string,
  ): void {
    // Common: Find or create message group
    const existing = this.findOrCreateMessageGroup(application, task, restartKey);

    // Try to handle as partial message first
    if (this.handlePartialMessage(msg, existing)) {
      return; // Message was handled
    }

    // Try to handle as final message
    if (this.handleFinalMessage(msg, existing)) {
      return; // Message was handled
    }

    // Common: Add as new message if not handled yet
    existing.messages.push(msg);
  }

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
    TQuery extends Record<string, string | undefined> = Record<
      string,
      string | undefined
    >,
  >(
    path: string,
    handler: (
      req: express.Request<TParams, unknown, TBody, TQuery>,
      res: express.Response,
    ) => void | Promise<unknown>,
  ): void {
    this.app.post(path, express.json(), handler as unknown as RequestHandler);
  }

  constructor(private app: express.Application) {}
  init() {
    // Initialize VE specific web app features here
    // POST /api/proxmox-configuration/:application/:task
    this.post<
      { application: string; task: string; veContext: string },
      IPostVeConfigurationBody
    >(ApiUri.VeConfiguration, async (req, res) => {
      const { application, task, veContext: veContextKey } = req.params;
      const { params, outputs, changedParams } = req.body;
      if (!Array.isArray(params)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid parameters" });
      }
      // Accept outputs array if provided (not yet used in processing)
      if (outputs !== undefined && !Array.isArray(outputs)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid outputs" });
      }
      // Accept changedParams array if provided (for vmInstallContext)
      if (changedParams !== undefined && !Array.isArray(changedParams)) {
        return res
          .status(400)
          .json({ success: false, error: "Invalid changedParams" });
      }
      try {
        // Load application (provides commands)
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
        
        // Save vmInstallContext if changedParams are provided
        if (changedParams && changedParams.length > 0) {
          const hostname = typeof veCtxToUse.host === "string" 
            ? veCtxToUse.host 
            : (veCtxToUse.host as any)?.host || "unknown";
          storageContext.setVMInstallContext({
            hostname,
            application,
            changedParams: changedParams.map(p => ({ name: p.name, value: p.value })),
          });
        }
        
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
        // 3. Process parameters: for upload parameters with "local:" prefix, read file and base64 encode
        const processedParams = await Promise.all(
          params.map(async (p) => {
            const paramDef = loaded.parameters.find(
              (param) => param.id === p.name,
            );
            if (
              paramDef?.upload &&
              typeof p.value === "string" &&
              p.value.startsWith("local:")
            ) {
              const filePath = p.value.substring(6); // Remove "local:" prefix
              const localPath = storageContext.getLocalPath();
              const fullPath = path.join(localPath, filePath);
              try {
                const fileContent = fs.readFileSync(fullPath);
                const base64Content = fileContent.toString("base64");
                return { id: p.name, value: base64Content };
              } catch (err: any) {
                throw new Error(
                  `Failed to read file ${fullPath}: ${err.message}`,
                );
              }
            }
            return { id: p.name, value: p.value };
          }),
        );
        // 4. Start ProxmoxExecution
        const inputs = processedParams.map((p) => ({
          id: p.id,
          value: p.value,
        }));
        const exec = new VeExecution(commands, inputs, veCtxToUse, defaults);
        // Generate restartKey upfront so we can return it immediately
        const newRestartKey = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

        // Clear old messages for this application/task before starting
        this.messages = this.messages.filter(
          (g) => !(g.application === application && g.task === task),
        );
        const messageKey = `${application}/${task}`;
        this.messageTimestamps.set(messageKey, Date.now());

        // Cleanup old messages periodically
        this.cleanupOldMessages();

        exec.on("message", (msg: IVeExecuteMessage) => {
          this.handleExecutionMessage(msg, application, task, newRestartKey);
        });
        exec.on("finished", (msg: IVMContext) => {
          veCtxToUse.getStorageContext().setVMContext(msg);
        });

        // Respond immediately with restartKey, run execution in background
        this.returnResponse<IVeConfigurationResponse>(res, {
          success: true,
          restartKey: newRestartKey,
        });

        // Run asynchronously - now non-blocking thanks to async spawn
        exec
          .run(null)
          .then((result) => {
            // Always store result (even on error, result contains state for retry)
            if (result) {
              this.restartInfos.set(newRestartKey, result);
            } else {
              // Fallback if no result returned
              this.restartInfos.set(newRestartKey, {
                lastSuccessfull: -1,
                inputs: params.map((p) => ({ name: p.name, value: p.value })),
                outputs: [],
                defaults: [],
              });
            }
          })
          .catch((err: Error) => {
            console.error("Execution error:", err.message);
            // Store minimal restartInfo so user can retry from beginning
            this.restartInfos.set(newRestartKey, {
              lastSuccessfull: -1,
              inputs: params.map((p) => ({ name: p.name, value: p.value })),
              outputs: [],
              defaults: [],
            });
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

    // POST /api/ve/restart/:restartKey/:veContext - Restart execution with stored restartInfo
    this.app.post(ApiUri.VeRestart, express.json(), async (req, res) => {
      const { restartKey, veContext: veContextKey } = req.params;

      const restartInfo = this.restartInfos.get(restartKey);
      if (!restartInfo) {
        return res
          .status(404)
          .json({ success: false, error: "Restart info not found" });
      }

      const storageContext = StorageContext.getInstance();
      const ctx = storageContext.getVEContextByKey(veContextKey);
      if (!ctx) {
        return res
          .status(404)
          .json({ success: false, error: "VE context not found" });
      }

      // Get application/task from the message group that has this restartKey
      const messageGroup = this.messages.find(
        (g) => g.restartKey === restartKey,
      );
      if (!messageGroup) {
        return res
          .status(404)
          .json({
            success: false,
            error: "No message group found for this restart key",
          });
      }

      const { application, task } = messageGroup;
      const veCtxToUse = ctx as IVEContext;

      // Reload application to get commands
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
        if (param.default !== undefined && !defaults.has(param.id)) {
          defaults.set(param.id, param.default);
        }
      });

      // Create execution with reloaded commands but use restartInfo for state
      const exec = new VeExecution(commands, [], veCtxToUse, defaults);

      // Generate new restartKey
      const newRestartKey = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

      // Clear old messages for this application/task
      this.messages = this.messages.filter(
        (g) => !(g.application === application && g.task === task),
      );
      const messageKey = `${application}/${task}`;
      this.messageTimestamps.set(messageKey, Date.now());

      exec.on("message", (msg: IVeExecuteMessage) => {
        this.handleExecutionMessage(msg, application, task, newRestartKey);
      });
      exec.on("finished", (msg: IVMContext) => {
        veCtxToUse.getStorageContext().setVMContext(msg);
      });

      this.returnResponse<IVeConfigurationResponse>(res, {
        success: true,
        restartKey: newRestartKey,
      });

      exec
        .run(restartInfo)
        .then((result) => {
          // Always store result (even on error, result contains state for retry)
          this.restartInfos.set(newRestartKey, result || restartInfo);
        })
        .catch((err: Error) => {
          console.error("Restart execution error:", err.message);
          // Even on error, store restartInfo so user can retry
          this.restartInfos.set(newRestartKey, restartInfo);
        });
    });
  }
}
