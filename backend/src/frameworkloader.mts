import path from "path";
import fs from "fs";
import { ApplicationLoader } from "./apploader.mjs";
import {
  IConfiguredPathes,
  IFramework,
  VEConfigurationError,
  IReadApplicationOptions,
} from "./backend-types.mjs";
import { StorageContext } from "./storagecontext.mjs";
import { JsonError } from "./jsonvalidator.mjs";
import { TemplateProcessor } from "./templateprocessor.mjs";
import { TaskType, IParameter, IPostFrameworkCreateApplicationBody } from "./types.mjs";
import { IVEContext } from "./backend-types.mjs";
import { FileSystemPersistence } from "./persistence/filesystem-persistence.mjs";

export interface IReadFrameworkOptions {
  framework?: IFramework;
  frameworkPath?: string;
  error: VEConfigurationError;
}

export class FrameworkLoader {
  constructor(
    private pathes: IConfiguredPathes,
    private storage: StorageContext = StorageContext.getInstance(),
    private applicationLoader?: ApplicationLoader,
  ) {
    if (!this.applicationLoader) {
      const persistence = new FileSystemPersistence(
        this.pathes,
        this.storage.getJsonValidator(),
      );
      this.applicationLoader = new ApplicationLoader(this.pathes, persistence, this.storage);
    }
  }

  public readFrameworkJson(
    framework: string,
    opts: IReadFrameworkOptions,
  ): IFramework {
    let frameworkPath: string | undefined;
    let frameworkFile: string | undefined;
    let frameworkName = framework;

    if (framework.startsWith("json:")) {
      frameworkName = framework.replace(/^json:/, "");
      frameworkPath = path.join(this.pathes.jsonPath, "frameworks");
      frameworkFile = path.join(frameworkPath, `${frameworkName}.json`);
      if (!fs.existsSync(frameworkFile)) {
        throw new Error(`framework json not found for ${framework}`);
      }
    } else {
      const localFile = path.join(
        this.pathes.localPath,
        "frameworks",
        `${framework}.json`,
      );
      const jsonFile = path.join(
        this.pathes.jsonPath,
        "frameworks",
        `${framework}.json`,
      );
      if (fs.existsSync(localFile)) {
        frameworkFile = localFile;
        frameworkPath = path.dirname(localFile);
      } else if (fs.existsSync(jsonFile)) {
        frameworkFile = jsonFile;
        frameworkPath = path.dirname(jsonFile);
      } else {
        throw new Error(`framework json not found for ${framework}`);
      }
    }

    const validator = this.storage.getJsonValidator();
    let frameworkData: IFramework;
    try {
      frameworkData = validator.serializeJsonFileWithSchema<IFramework>(
        frameworkFile,
        "framework",
      );
    } catch (e: Error | any) {
      this.addErrorToOptions(opts, e);
      throw opts.error;
    }

    frameworkData.id = frameworkName;
    opts.framework = frameworkData;
    opts.frameworkPath = frameworkPath;
    return frameworkData;
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

    const templateProcessor = new TemplateProcessor(this.pathes, this.storage);
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
    const templateProcessor = new TemplateProcessor(this.pathes, this.storage);
    const allParameters = await templateProcessor.getParameters(
      framework.extends,
      "installation",
    );

    // Check if application already exists in localPath or jsonPath
    const localAppDir = path.join(
      this.pathes.localPath,
      "applications",
      request.applicationId,
    );
    const jsonAppDir = path.join(
      this.pathes.jsonPath,
      "applications",
      request.applicationId,
    );

    if (fs.existsSync(localAppDir)) {
      throw new Error(
        `Application ${request.applicationId} already exists at ${localAppDir}`,
      );
    }
    if (fs.existsSync(jsonAppDir)) {
      throw new Error(
        `Application ${request.applicationId} already exists at ${jsonAppDir}`,
      );
    }

    // Create application directory in localPath
    const appDir = localAppDir;
    const templatesDir = path.join(appDir, "templates");

    // Create directories
    fs.mkdirSync(templatesDir, { recursive: true });

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

    // Write the prepend template
    fs.writeFileSync(
      path.join(templatesDir, prependTemplateName),
      JSON.stringify(setParametersTemplate, null, 2),
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

    // Write application.json
    fs.writeFileSync(
      path.join(appDir, "application.json"),
      JSON.stringify(applicationJson, null, 2),
    );

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

