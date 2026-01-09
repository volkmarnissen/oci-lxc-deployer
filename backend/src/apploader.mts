import {
  IApplication,
  IConfiguredPathes,
  VEConfigurationError,
} from "@src/backend-types.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { ITemplateReference } from "./templateprocessor.mjs";
import { JsonError } from "./jsonvalidator.mjs";
import { IApplicationPersistence } from "./persistence/interfaces.mjs";
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
    private persistence: IApplicationPersistence,
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
    // Handle json: prefix
    let appName = application;
    if (application.startsWith("json:")) {
      appName = application.replace(/^json:/, "");
    }

    // Use persistence to read application
    // This already handles inheritance, icons, and template processing
    return this.persistence.readApplication(appName, opts);
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
