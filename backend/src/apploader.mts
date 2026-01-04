import {
  IApplication,
  IConfiguredPathes,
  VEConfigurationError,
} from "@src/backend-types.mjs";
import path from "path";
import fs from "fs";
import { StorageContext } from "./storagecontext.mjs";
import { ITemplateReference } from "./templateprocessor.mjs";
import { JsonError } from "./jsonvalidator.mjs";
export interface IReadApplicationOptions {
  applicationHierarchy: string[];
  application?: IApplication;
  appPath?: string;
  error: VEConfigurationError;
  taskTemplates: {
    task: string;
    templates: (ITemplateReference | string)[];
  }[];
  inheritedIcon?: string;
  inheritedIconContent?: string;
  inheritedIconType?: string;
}
export class ApplicationLoader {
  constructor(
    private pathes: IConfiguredPathes,
    private storage: StorageContext = StorageContext.getInstance(),
  ) {}
  /**
   * Reads the application.json for an application, supports inheritance and template list manipulation.
   * @param application Name of the application (optionally with json: prefix)
   * @param opts Options with applicationHierarchy and templates
   */
  public readApplicationJson(
    application: string,
    opts: IReadApplicationOptions,
  ): IApplication {
    let appPath: string | undefined;
    let appFile: string | undefined;
    let appName = application;

    if (application.startsWith("json:")) {
      appName = application.replace(/^json:/, "");
      appPath = path.join(this.pathes.jsonPath, "applications", appName);
      appFile = path.join(appPath, "application.json");
      if (!fs.existsSync(appFile))
        throw new Error(`application.json not found for ${application}`);
    } else {
      // First check local, then json
      let localPath = path.join(
        this.pathes.localPath,
        "applications",
        application,
        "application.json",
      );
      let jsonPath = path.join(
        this.pathes.jsonPath,
        "applications",
        application,
        "application.json",
      );
      if (fs.existsSync(localPath)) {
        appFile = localPath;
        appPath = path.dirname(localPath);
      } else if (fs.existsSync(this.pathes.jsonPath)) {
        appFile = jsonPath;
        appPath = path.dirname(jsonPath);
      } else {
        throw new Error(`application.json not found for ${application}`);
      }
    }
    if (opts.applicationHierarchy.includes(appPath)) {
      throw new Error(
        `Cyclic inheritance detected for application: ${appName}`,
      );
    }
    // Read and validate file
    const validator = this.storage.getJsonValidator();
    let appData: IApplication;
    try {
      try{
        appData = validator.serializeJsonFileWithSchema<IApplication>(
          appFile,
          "application",
        );
      } catch (e: Error | any) {
        appData = {
          id: application,
          name: application
        }
        this.addErrorToOptions(opts, e);
      }

      appData.id = appName;

      // Save the first application in the hierarchy
      if (!opts.application) {
        opts.application = appData;
        opts.appPath = appPath;
      }
      // First application is first in hierarchy
      opts.applicationHierarchy.push(appPath);

      // Recursive inheritance - load parent first to get icon data
      if (appData.extends) {
        try {
          this.readApplicationJson(appData.extends, opts);
        } catch (e: Error | any) {
          this.addErrorToOptions(opts, e);
        }
      }

      // Check for icon in the application directory (supports .png and .svg)
      let icon = appData?.icon ? appData.icon : "icon.png";
      let iconFound = false;
      if (appPath) {
        const iconPath = path.join(appPath, icon);
        if (fs.existsSync(iconPath)) {
          appData.icon = icon;
          appData.iconContent = fs.readFileSync(iconPath, {
            encoding: "base64",
          });
          // Determine MIME type based on file extension
          const ext = path.extname(icon).toLowerCase();
          appData.iconType = ext === ".svg" ? "image/svg+xml" : "image/png";
          iconFound = true;
          // Store icon data for inheritance
          opts.inheritedIcon = icon;
          opts.inheritedIconContent = appData.iconContent;
          opts.inheritedIconType = appData.iconType;
        }
      }

      // If no icon found and we have inherited icon data from parent, use it
      if (!iconFound && opts.inheritedIconContent) {
        appData.icon = opts.inheritedIcon || "icon.png";
        appData.iconContent = opts.inheritedIconContent;
        appData.iconType = opts.inheritedIconType;
      }
      this.processTemplates(appData, opts);
      return appData;
    } catch (e: Error | any) {
      this.addErrorToOptions(opts, e);
    }
    throw opts.error;
  }

  /**
   * Adds an error to the options error details array.
   * @param opts Read application options
   * @param error Error to add
   */
  private addErrorToOptions(opts: IReadApplicationOptions, error: Error | any): void {
    if (opts.error && Array.isArray(opts.error.details)) {
      opts.error.details.push(error);
    } else if (opts.error) {
      opts.error.details = [error];
    }
  }

  /**
   * Adds a template to the task entry. Duplicates are not allowed and will cause an error.
   * @param templateName Name of the template to add
   * @param taskEntry Task entry to add the template to
   * @param taskName Name of the task (e.g., "installation")
   * @param opts Options to add errors to
   */
  private addTemplateToTask(
    templateName: string,
    taskEntry: { task: string; templates: (ITemplateReference | string)[] },
    taskName: string,
    opts: IReadApplicationOptions,
  ): void {
    // Check for duplicates - duplicates are not allowed
    const templateNameStr = typeof templateName === "string" ? templateName : templateName;
    const existingTemplates = taskEntry.templates.map(t => typeof t === "string" ? t : t.name);
    if (existingTemplates.includes(templateNameStr)) {
      const error = new JsonError(
        `Template '${templateNameStr}' appears multiple times in ${taskName} task. Each template can only appear once per task.`,
      );
      this.addErrorToOptions(opts, error);
      return; // Don't add duplicate
    }
    taskEntry.templates.push(templateName);
  }

  private processTemplates(
    appData: IApplication,
    opts: IReadApplicationOptions,
  ) {
    const taskKeys = [
      "installation",
      "backup",
      "restore",
      "uninstall",
      "update",
      "upgrade",
      "webui",
    ];
    for (const key of taskKeys) {
      const list = (appData as any)[key];
      let taskEntry = opts.taskTemplates.find((t) => t.task === key);
      if (!taskEntry) {
        taskEntry = { task: key, templates: [] };
        opts.taskTemplates.push(taskEntry);
      }
      if (Array.isArray(list)) {
        for (const entry of list) {
          if (typeof entry === "string") {
            this.addTemplateToTask(entry, taskEntry, key, opts);
          } else if (typeof entry === "object" && entry !== null) {
            const name = entry.name;
            if (!name) continue;
            if (entry.before && Array.isArray(entry.before) && entry.before.length > 0) {
              // before is an array, use the first element
              const beforeName = entry.before[0];
              const existingTemplates = taskEntry.templates.map(t => typeof t === "string" ? t : t.name);
              // Check for duplicates before inserting
              if (existingTemplates.includes(name)) {
                const error = new JsonError(
                  `Template '${name}' appears multiple times in ${key} task. Each template can only appear once per task.`,
                );
                this.addErrorToOptions(opts, error);
                return; // Don't add duplicate
              }
              const idx = existingTemplates.indexOf(beforeName);
              if (idx !== -1) {
                taskEntry.templates.splice(idx, 0, name);
              } else {
                this.addTemplateToTask(name, taskEntry, key, opts);
              }
            } else if (entry.after && Array.isArray(entry.after) && entry.after.length > 0) {
              // after is an array, use the first element
              const afterName = entry.after[0];
              const existingTemplates = taskEntry.templates.map(t => typeof t === "string" ? t : t.name);
              // Check for duplicates before inserting
              if (existingTemplates.includes(name)) {
                const error = new JsonError(
                  `Template '${name}' appears multiple times in ${key} task. Each template can only appear once per task.`,
                );
                this.addErrorToOptions(opts, error);
                return; // Don't add duplicate
              }
              const idx = existingTemplates.indexOf(afterName);
              if (idx !== -1) {
                taskEntry.templates.splice(idx + 1, 0, name);
              } else {
                this.addTemplateToTask(name, taskEntry, key, opts);
              }
            } else {
              this.addTemplateToTask(name, taskEntry, key, opts);
            }
          }
        }
      }
    }
  }
}
