import fs from "node:fs";
import path from "node:path";
import { ApplicationLoader } from "../apploader.mjs";
import type {
  IConfiguredPathes,
  IReadApplicationOptions,
} from "../backend-types.mjs";
import { VEConfigurationError } from "../backend-types.mjs";
import type {  IApplicationWeb, ITemplate } from "../types.mjs";
import type { IApplication } from "../../tests/ve-test-helper.mjs";
import type { IApplicationPersistence, ITemplatePersistence } from "./interfaces.mjs";
import { TemplatePathResolver } from "../templates/template-path-resolver.mjs";
import { MarkdownReader } from "../markdown-reader.mjs";

export type TemplateScope = "application" | "shared";

export interface TemplateRef {
  name: string;
  scope: TemplateScope;
  applicationId?: string;
  origin?: "local" | "json";
}

export interface ScriptRef {
  name: string;
  scope: TemplateScope;
  applicationId?: string;
}

export interface MarkdownRef {
  templateName: string;
  scope: TemplateScope;
  applicationId?: string;
}

export interface IApplicationRepository {
  getApplication(applicationId: string): IApplication;
  listApplications(): IApplicationWeb[];
  getApplicationIcon(applicationId: string): { iconContent: string; iconType: string } | null;
}

export interface ITemplateRepository {
  resolveTemplateRef(applicationId: string, templateName: string): TemplateRef | null;
  getTemplate(ref: TemplateRef): ITemplate | null;
}

export interface IResourceRepository {
  getScript(ref: ScriptRef): string | null;
  resolveScriptPath(ref: ScriptRef): string | null;
  resolveLibraryPath(ref: ScriptRef): string | null;
  getMarkdown(ref: MarkdownRef): string | null;
  getMarkdownSection(ref: MarkdownRef, sectionName: string): string | null;
}

export class FileSystemRepositories implements IApplicationRepository, ITemplateRepository, IResourceRepository {
  constructor(
    private pathes: IConfiguredPathes,
    private persistence: IApplicationPersistence & ITemplatePersistence,
  ) {}

  listApplications(): IApplicationWeb[] {
    return this.persistence.listApplicationsForFrontend();
  }

  getApplicationIcon(applicationId: string): { iconContent: string; iconType: string } | null {
    return this.persistence.readApplicationIcon(applicationId);
  }

  getApplication(applicationId: string): IApplication {
    const appLoader = new ApplicationLoader(this.pathes, this.persistence);
    const readOpts: IReadApplicationOptions = {
      applicationHierarchy: [],
      error: new VEConfigurationError("", applicationId),
      taskTemplates: [],
    };
    return appLoader.readApplicationJson(applicationId, readOpts);
  }

  resolveTemplateRef(applicationId: string, templateName: string): TemplateRef | null {
    const appPath = this.getApplicationPath(applicationId);
    if (!appPath) return null;
    const resolved = TemplatePathResolver.resolveTemplatePath(
      templateName,
      appPath,
      this.pathes,
    );
    if (!resolved) return null;
    const origin = resolved.fullPath.startsWith(this.pathes.localPath)
      ? "local"
      : resolved.fullPath.startsWith(this.pathes.jsonPath)
        ? "json"
        : undefined;
    const name = TemplatePathResolver.normalizeTemplateName(templateName);
    return {
      name,
      scope: resolved.isShared ? "shared" : "application",
      applicationId: resolved.isShared ? undefined : applicationId,
      origin,
    };
  }

  getTemplate(ref: TemplateRef): ITemplate | null {
    if (ref.scope === "shared") {
      const templatePath = this.persistence.resolveTemplatePath(ref.name, true);
      if (!templatePath) return null;
      return this.persistence.loadTemplate(templatePath);
    }

    const appPath = this.getApplicationPath(ref.applicationId);
    if (!appPath) return null;
    const resolved = TemplatePathResolver.resolveTemplatePath(
      ref.name,
      appPath,
      this.pathes,
    );
    if (!resolved) return null;
    return this.persistence.loadTemplate(resolved.fullPath);
  }

  getScript(ref: ScriptRef): string | null {
    const scriptPath = this.resolveScriptPath(ref);
    if (!scriptPath || !fs.existsSync(scriptPath)) return null;
    return fs.readFileSync(scriptPath, "utf-8");
  }

  resolveScriptPath(ref: ScriptRef): string | null {
    let scriptPath: string | null = null;
    if (ref.scope === "shared") {
      const localShared = path.join(
        this.pathes.localPath,
        "shared",
        "scripts",
        ref.name,
      );
      const jsonShared = path.join(
        this.pathes.jsonPath,
        "shared",
        "scripts",
        ref.name,
      );
      if (fs.existsSync(localShared)) scriptPath = localShared;
      else if (fs.existsSync(jsonShared)) scriptPath = jsonShared;
    } else {
      const appPath = this.getApplicationPath(ref.applicationId);
      if (appPath) {
        scriptPath = TemplatePathResolver.resolveScriptPath(
          ref.name,
          appPath,
          this.pathes,
        );
      }
    }
    return scriptPath;
  }

  resolveLibraryPath(ref: ScriptRef): string | null {
    return this.resolveScriptPath(ref);
  }

  getMarkdown(ref: MarkdownRef): string | null {
    const templatePath = this.resolveTemplatePathForMarkdown(ref);
    if (!templatePath) return null;
    const mdPath = MarkdownReader.getMarkdownPath(templatePath);
    if (!fs.existsSync(mdPath)) return null;
    return fs.readFileSync(mdPath, "utf-8");
  }

  getMarkdownSection(ref: MarkdownRef, sectionName: string): string | null {
    const templatePath = this.resolveTemplatePathForMarkdown(ref);
    if (!templatePath) return null;
    const mdPath = MarkdownReader.getMarkdownPath(templatePath);
    return MarkdownReader.extractSection(mdPath, sectionName);
  }

  private resolveTemplatePathForMarkdown(ref: MarkdownRef): string | null {
    if (ref.scope === "shared") {
      return this.persistence.resolveTemplatePath(ref.templateName, true);
    }

    const appPath = this.getApplicationPath(ref.applicationId);
    if (!appPath) return null;
    const resolved = TemplatePathResolver.resolveTemplatePath(
      ref.templateName,
      appPath,
      this.pathes,
    );
    return resolved?.fullPath ?? null;
  }

  private getApplicationPath(applicationId?: string): string | null {
    if (!applicationId) return null;
    const normalizedId = applicationId.startsWith("json:")
      ? applicationId.replace(/^json:/, "")
      : applicationId;
    const allApps = this.persistence.getAllAppNames();
    const cached = allApps.get(normalizedId);
    if (cached) return cached;

    const localCandidate = path.join(
      this.pathes.localPath,
      "applications",
      normalizedId,
    );
    if (fs.existsSync(path.join(localCandidate, "application.json"))) {
      return localCandidate;
    }

    const jsonCandidate = path.join(
      this.pathes.jsonPath,
      "applications",
      normalizedId,
    );
    if (fs.existsSync(path.join(jsonCandidate, "application.json"))) {
      return jsonCandidate;
    }

    return null;
  }
}
