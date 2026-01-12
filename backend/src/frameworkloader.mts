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
import { PersistenceManager } from "./persistence/persistence-manager.mjs";

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
      // ApplicationLoader expects StorageContext | undefined
      const storageContext = this.storage instanceof StorageContext ? this.storage : undefined;
      this.applicationLoader = new ApplicationLoader(this.pathes, this.persistence, storageContext);
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

    // TemplateProcessor expects ContextManager, not StorageContext
    const contextManager = this.storage instanceof ContextManager 
      ? this.storage 
      : (this.storage as any).contextManager || PersistenceManager.getInstance().getContextManager();
    const templateProcessor = new TemplateProcessor(this.pathes, contextManager, this.persistence);
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
    // TemplateProcessor expects ContextManager, not StorageContext
    const contextManager = this.storage instanceof ContextManager 
      ? this.storage 
      : (this.storage as any).contextManager || PersistenceManager.getInstance().getContextManager();
    const templateProcessor = new TemplateProcessor(this.pathes, contextManager, this.persistence);
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
    // Note: Templates from the extended application (framework.extends) are automatically
    // loaded through the 'extends' mechanism. We should NOT add them to the installation
    // list again, as this would cause duplicates.
    // The installation list should only contain templates specific to this application,
    // which can use 'before' or 'after' to position themselves relative to templates
    // from the extended application.
    const applicationJson: any = {
      name: request.name,
      description: request.description,
      extends: framework.extends,
      icon: request.icon || baseApplication.icon || "icon.png",
      // Only include the prepend template, positioned before the first template from extends
      // If baseApplication has installation templates, we can reference the first one
      installation: baseApplication.installation && baseApplication.installation.length > 0
        ? [{
            name: prependTemplateName,
            before: typeof baseApplication.installation[0] === 'string' 
              ? baseApplication.installation[0] 
              : (baseApplication.installation[0] as any).name || (baseApplication.installation[0] as any).id
          }]
        : [prependTemplateName],
    };

    // Optional OCI / metadata fields: prefer request overrides, then framework, then base application
    const url = request.url ?? (framework as any).url ?? (baseApplication as any).url;
    const documentation =
      request.documentation ?? (framework as any).documentation ?? (baseApplication as any).documentation;
    const source = request.source ?? (framework as any).source ?? (baseApplication as any).source;
    const vendor = request.vendor ?? (framework as any).vendor ?? (baseApplication as any).vendor;

    if (url) {
      applicationJson.url = url;
    }
    if (documentation) {
      applicationJson.documentation = documentation;
    }
    if (source) {
      applicationJson.source = source;
    }
    if (vendor) {
      applicationJson.vendor = vendor;
    }

    // Write application.json using persistence
    // Note: We pass applicationJson without 'id' - it will be added when reading
    // Type assertion needed because writeApplication expects IApplication, but we don't want to write 'id'
    this.persistence.writeApplication(request.applicationId, applicationJson as any);

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

