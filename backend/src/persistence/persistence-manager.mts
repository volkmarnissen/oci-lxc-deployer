import path from "path";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { JsonValidator } from "../jsonvalidator.mjs";
import { IConfiguredPathes } from "../backend-types.mjs";
import { FileSystemPersistence } from "./filesystem-persistence.mjs";
import {
  IApplicationPersistence,
  ITemplatePersistence,
  IFrameworkPersistence,
} from "./interfaces.mjs";
import { ApplicationService } from "../services/application-service.mjs";
import { FrameworkService } from "../services/framework-service.mjs";
import { ContextManager } from "../context-manager.mjs";
import { FileSystemRepositories } from "./repositories.mjs";

const baseSchemas: string[] = ["templatelist.schema.json"];

/**
 * Central singleton manager for Persistence, Services and ContextManager
 * Replaces StorageContext singleton for entity access (Applications, Templates, Frameworks)
 * 
 * Architecture:
 * - PersistenceManager: Central singleton, manages all persistence and services
 * - ContextManager: Manages execution contexts (VE, VM, VMInstall), no longer a singleton
 * - ApplicationService: Wraps IApplicationPersistence
 * - FrameworkService: Wraps IFrameworkPersistence
 * - FileSystemPersistence: Implements persistence interfaces with caching
 */
export class PersistenceManager {
  private static instance: PersistenceManager | undefined;

  private pathes: IConfiguredPathes;
  private jsonValidator: JsonValidator;
  private persistence: IApplicationPersistence &
    IFrameworkPersistence &
    ITemplatePersistence;
  private applicationService: ApplicationService;
  private frameworkService: FrameworkService;
  private contextManager: ContextManager;
  private repositories: FileSystemRepositories;

  private constructor(
    localPath: string,
    storageContextFilePath: string,
    secretFilePath: string,
    enableCache: boolean = true,
    jsonPath?: string,
    schemaPath?: string,
  ) {
    // Create paths (same logic as StorageContext)
    // persistence-manager.mts is in backend/src/persistence/
    // So we need to go up 3 levels: ../../.. to project root
    const persistenceDir = dirname(fileURLToPath(import.meta.url)); // backend/src/persistence
    const projectRoot = join(persistenceDir, "../../.."); // project root
    this.pathes = {
      localPath: localPath,
      jsonPath: jsonPath || path.join(projectRoot, "json"),
      schemaPath: schemaPath || path.join(projectRoot, "schemas"),
    };

    // Create JsonValidator (same logic as StorageContext)
    this.jsonValidator = new JsonValidator(this.pathes.schemaPath, baseSchemas);

    // Initialize Persistence (uses same pathes and validator)
    this.persistence = new FileSystemPersistence(
      this.pathes,
      this.jsonValidator,
      enableCache,
    );

    // Initialize Services
    this.applicationService = new ApplicationService(this.persistence);
    this.frameworkService = new FrameworkService(this.persistence);

    // Initialize ContextManager (no longer a singleton itself)
    // Pass pathes, validator and persistence to avoid duplication
    this.contextManager = new ContextManager(
      localPath,
      storageContextFilePath,
      secretFilePath,
      this.pathes,
      this.jsonValidator,
      this.persistence,
    );

    this.repositories = new FileSystemRepositories(this.pathes, this.persistence);
  }

  /**
   * Initializes the PersistenceManager singleton
   * This replaces StorageContext.setInstance()
   * 
   * If already initialized, closes the existing instance first (useful for tests)
   */
  static initialize(
    localPath: string,
    storageContextFilePath: string,
    secretFilePath: string,
    enableCache: boolean = true,
    jsonPath?: string,
    schemaPath?: string,
  ): PersistenceManager {
    if (PersistenceManager.instance) {
      // Close existing instance (useful for tests)
      PersistenceManager.instance.close();
    }
    PersistenceManager.instance = new PersistenceManager(
      localPath,
      storageContextFilePath,
      secretFilePath,
      enableCache,
      jsonPath,
      schemaPath,
    );
    return PersistenceManager.instance;
  }

  /**
   * Gets the PersistenceManager singleton instance
   */
  static getInstance(): PersistenceManager {
    if (!PersistenceManager.instance) {
      throw new Error(
        "PersistenceManager not initialized. Call initialize() first.",
      );
    }
    return PersistenceManager.instance;
  }

  // Getters für Zugriff auf Komponenten
  getPersistence(): IApplicationPersistence &
    IFrameworkPersistence &
    ITemplatePersistence {
    return this.persistence;
  }

  getApplicationService(): ApplicationService {
    return this.applicationService;
  }

  getFrameworkService(): FrameworkService {
    return this.frameworkService;
  }

  getPathes(): IConfiguredPathes {
    return this.pathes;
  }

  getJsonValidator(): JsonValidator {
    return this.jsonValidator;
  }

  getContextManager(): ContextManager {
    return this.contextManager;
  }

  getRepositories(): FileSystemRepositories {
    return this.repositories;
  }

  // Alias für Rückwärtskompatibilität (kann später entfernt werden)
  getStorageContext(): ContextManager {
    return this.contextManager;
  }

  /**
   * Cleanup (closes file watchers, etc.)
   */
  close(): void {
    if (this.persistence && "close" in this.persistence) {
      this.persistence.close();
    }
    PersistenceManager.instance = undefined;
  }
}

