import path from "path";
import fs from "fs";
import { ApplicationLoader } from "./apploader.mjs";
import {
  IConfiguredPathes,
  VEConfigurationError,
  IReadApplicationOptions,
} from "./backend-types.mjs";
import { IFramework } from "./types.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { ContextManager } from "./context-manager.mjs";
import { JsonError } from "./jsonvalidator.mjs";
import { TemplateProcessor } from "./templateprocessor.mjs";
import { TaskType, IParameter, IPostFrameworkCreateApplicationBody } from "./types.mjs";
import { IVEContext } from "./backend-types.mjs";
import { FileSystemPersistence } from "./persistence/filesystem-persistence.mjs";
import { IFrameworkPersistence, IApplicationPersistence, ITemplatePersistence } from "./persistence/interfaces.mjs";

export interface IReadFrameworkOptions {
  framework?: IFramework;
  frameworkPath?: string;
  error: VEConfigurationError;
}

export class FrameworkLoader {
  constructor(
    private pathes: IConfiguredPathes,
    private storage: StorageContext | ContextManager = StorageContext.getInstance(),
    private persistence: IFrameworkPersistence & IApplicationPersistence & ITemplatePersistence,
    private applicationLoader?: ApplicationLoader,
  ) {
    if (!this.applicationLoader) {
      this.applicationLoader = new ApplicationLoader(this.pathes, this.persistence, this.storage);
    }
  }

  public readFrameworkJson(
    framework: string,
    opts: IReadFrameworkOptions,
  ): IFramework {
    return this.persistence.readFramework(framework, opts);
  }

  public async getParameters(
    framework: string,
    task: TaskType,
    veContext: IVEContext,
  ): Promise<IParameter[]> {
    const opts: IReadFrameworkOptions = {
      error: new VEConfigurationError("", framework),
    };
    const frameworkData = this.readFrameworkJson(framework, opts);

    const appOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new VEConfigurationError("", frameworkData.extends),
      taskTemplates: [],
    };
    // Validate and load base application (errors are collected in appOpts)
    try {
      this.applicationLoader!.readApplicationJson(
        frameworkData.extends,
        appOpts,
      );
    } catch (e: Error | any) {
      this.addErrorToOptions(opts, e);
    }

    const templateProcessor = new TemplateProcessor(this.pathes, this.storage, this.persistence);
    const loaded = await templateProcessor.getParameters(
      frameworkData.extends,
      task,
      veContext,
    );

    const propertyIds = (frameworkData.properties || []).map((p) =>
      typeof p === "string" ? p : p.id,
    );
    const result: IParameter[] = [];
    for (const propId of propertyIds) {
      const match = loaded.find((p) => p.id === propId);
      if (match) {
        // Clone parameter and apply framework-specific rules:
        // - remove 'advanced'
        // - force required: true
        const cloned: IParameter = { ...match };
        delete (cloned as any).advanced;
        cloned.required = true;
        result.push(cloned);
      }
    }
    return result;
  }

  public async createApplicationFromFramework(
    request: IPostFrameworkCreateApplicationBody,
  ): Promise<string> {
    // Load framework
    const frameworkOpts: IReadFrameworkOptions = {
      error: new VEConfigurationError("", request.frameworkId),
    };
    const framework = this.readFrameworkJson(request.frameworkId, frameworkOpts);

    // Load base application to get template list
    const appOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new VEConfigurationError("", framework.extends),
      taskTemplates: [],
    };
    const baseApplication = this.applicationLoader!.readApplicationJson(
      framework.extends,
      appOpts,
    );

    // Get all parameters from base application to find parameter definitions
    // No veContext needed - we only need parameter definitions, not execution
    const templateProcessor = new TemplateProcessor(this.pathes, this.storage, this.persistence);
    const allParameters = await templateProcessor.getParameters(
      framework.extends,
      "installation",
    );

    // Check if application already exists using persistence
    const allAppNames = this.persistence.getAllAppNames();
    if (allAppNames.has(request.applicationId)) {
      const existingAppPath = allAppNames.get(request.applicationId)!;
      throw new Error(
        `Application ${request.applicationId} already exists at ${existingAppPath}`,
      );
    }

    // Application directory will be created by writeApplication
    const appDir = path.join(
      this.pathes.localPath,
      "applications",
      request.applicationId,
    );

    // Build parameterValues map for quick lookup
    const paramValuesMap = new Map<string, string | number | boolean>();
    for (const pv of request.parameterValues) {
      paramValuesMap.set(pv.id, pv.value);
    }

    // Separate properties into parameters (default: true) and outputs (others)
    const templateParameters: IParameter[] = [];
    const templateProperties: Array<{ id: string; value: string | number | boolean }> = [];

    for (const prop of framework.properties) {
      const propId = typeof prop === "string" ? prop : prop.id;
      const isDefault = typeof prop === "object" && prop.default === true;

      // Find parameter definition from base application
      const paramDef = allParameters.find((p) => p.id === propId);
      const paramValue = paramValuesMap.get(propId);

      if (isDefault && paramDef) {
        // Create parameter entry
        const param: IParameter = {
          ...paramDef,
        };
        if (paramValue !== undefined) {
          param.default = paramValue;
        } else if (paramDef.default !== undefined) {
          param.default = paramDef.default;
        }
        templateParameters.push(param);
      } else if (paramValue !== undefined) {
        // Create property/output entry
        templateProperties.push({
          id: propId,
          value: paramValue,
        });
      }
    }

    // Create set-parameters.json template
    const setParametersTemplate = {
      execute_on: "ve",
      name: "Set Parameters",
      description: `Set application-specific parameters for ${request.name}`,
      parameters: templateParameters,
      commands: [
        {
          name: "set-properties",
          properties: templateProperties,
        },
      ],
    };

    // Determine template name to prepend: derive from application-id or use set-parameters.json
    const prependTemplateName = `${request.applicationId}-parameters.json`;

    // Write the prepend template using persistence
    this.persistence.writeTemplate(
      prependTemplateName,
      setParametersTemplate,
      false, // isShared = false (application-specific)
      appDir, // appPath
    );

    // Create application.json
    // Get installation templates from base application
    const baseInstallation = baseApplication.installation || [];
    const applicationJson = {
      name: request.name,
      description: request.description,
      extends: framework.extends,
      icon: request.icon || baseApplication.icon || "icon.png",
      installation: [prependTemplateName, ...baseInstallation],
    };

    // Write application.json using persistence
    this.persistence.writeApplication(request.applicationId, applicationJson);

    // Write icon if provided
    if (request.iconContent) {
      const iconPath = path.join(appDir, request.icon || "icon.png");
      const iconBuffer = Buffer.from(request.iconContent, "base64");
      fs.writeFileSync(iconPath, iconBuffer);
    }

    return request.applicationId;
  }

  private addErrorToOptions(opts: IReadFrameworkOptions, error: Error | any) {
    if (opts.error && Array.isArray(opts.error.details)) {
      opts.error.details.push(error);
    } else if (opts.error) {
      opts.error.details = [error];
    } else {
      throw new JsonError(error?.message || String(error));
    }
  }
}

