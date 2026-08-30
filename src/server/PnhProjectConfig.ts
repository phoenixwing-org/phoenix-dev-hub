import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  LocalNodeProject,
  LocalNodeProjectCandidate,
  LocalProjectCatalogResponse,
  LocalProjectTransferDocument,
  NodePackageManager,
  ServiceDefinition,
} from "../shared/contracts.js";
import { HubError } from "./errors.js";

interface LocalProjectFile {
  readonly version: 1;
  readonly projects: readonly LocalNodeProject[];
}

const ID_PATTERN = /^[a-z][a-z0-9-]{1,63}$/;
const PACKAGE_MANAGERS = new Set<NodePackageManager>(["pnpm", "npm", "yarn", "bun"]);
const MAX_IMPORTED_PROJECTS = 100;

export interface PnhProjectImportChange {
  readonly project: LocalNodeProject;
  readonly definition: ServiceDefinition;
}

export interface PnhProjectImportPlan {
  readonly projects: readonly LocalNodeProject[];
  readonly added: readonly PnhProjectImportChange[];
  readonly updated: readonly PnhProjectImportChange[];
}

function configError(message: string, statusCode = 500): never {
  throw new HubError("INVALID_LOCAL_PROJECT", message, statusCode);
}

function objectValue(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return configError(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    return configError(`${label} 必须是非空字符串`);
  }
  return value.trim();
}

function projectName(value: unknown, fallback: string): string {
  const name = value === undefined ? fallback : stringValue(value, "项目显示名称");
  if (name.length > 120) return configError("项目显示名称不能超过 120 个字符", 400);
  return name;
}

function slug(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (/^[a-z]/.test(normalized) ? normalized : `project-${normalized || "node"}`)
    .slice(0, 48)
    .replace(/-+$/g, "");
}

function uniqueId(base: string, used: ReadonlySet<string>): string {
  for (let index = 1; ; index += 1) {
    const suffix = index === 1 ? "" : `-${index}`;
    const candidate = `${base.slice(0, 64 - suffix.length).replace(/-+$/g, "")}${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
}

function packageManager(
  directory: string,
  manifest: Readonly<Record<string, unknown>>,
): NodePackageManager {
  if (typeof manifest.packageManager === "string") {
    const name = manifest.packageManager.split("@", 1)[0] as NodePackageManager;
    if (PACKAGE_MANAGERS.has(name)) return name;
  }
  if (existsSync(path.join(directory, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(directory, "yarn.lock"))) return "yarn";
  if (existsSync(path.join(directory, "bun.lock")) || existsSync(path.join(directory, "bun.lockb"))) {
    return "bun";
  }
  return "npm";
}

function serviceDefinition(project: LocalNodeProject): ServiceDefinition {
  return {
    id: project.serviceId,
    name: project.name,
    moduleId: project.id,
    moduleName: project.name,
    description: `${project.packageManager} · ${project.script}（本机项目）`,
    cwd: project.directory,
    command: project.packageManager === "npm"
      ? { executable: "npm", args: ["run", project.script] }
      : { executable: project.packageManager, args: [project.script] },
    endpoints: [],
    externalStop: "deny",
    localProjectId: project.id,
    configurationSource: "user",
  };
}

/** 管理 Hub 本机私有的 Node.js 项目清单。 */
export class PnhProjectConfigStore {
  readonly #projectRoot: string;
  readonly #defaultRoot: string;
  readonly #configPath: string;
  #projects: LocalNodeProject[];

  constructor(projectRoot: string) {
    this.#projectRoot = realpathSync(path.resolve(projectRoot));
    this.#defaultRoot = path.dirname(this.#projectRoot);
    this.#configPath = path.join(this.#projectRoot, ".runtime/projects.json");
    this.#projects = this.#load();
  }

  listProjects(): readonly LocalNodeProject[] {
    return this.#projects;
  }

  serviceDefinitions(): readonly ServiceDefinition[] {
    return this.#projects.map((project) => {
      const candidate = this.inspect(project.directory);
      if (!candidate.scripts.includes(project.script)) {
        return configError(`本机项目 ${project.name} 已不存在 script：${project.script}`);
      }
      return serviceDefinition({ ...project, packageManager: candidate.packageManager });
    });
  }

  catalog(): LocalProjectCatalogResponse {
    return {
      defaultRoot: this.#defaultRoot,
      projects: this.#projects,
      candidates: this.#discover(),
    };
  }

  inspect(directoryInput: string): LocalNodeProjectCandidate {
    const input = path.isAbsolute(directoryInput)
      ? directoryInput
      : path.resolve(this.#defaultRoot, directoryInput);
    let directory: string;
    try {
      directory = realpathSync(input);
    } catch {
      return configError(`本地目录不存在：${directoryInput}`, 400);
    }
    if (!statSync(directory).isDirectory()) {
      return configError(`本地路径不是目录：${directory}`, 400);
    }

    const manifestPath = path.join(directory, "package.json");
    if (!existsSync(manifestPath)) {
      return configError(`目录中没有 package.json：${directory}`, 400);
    }
    let manifest: Record<string, unknown>;
    try {
      manifest = objectValue(JSON.parse(readFileSync(manifestPath, "utf8")) as unknown, "package.json");
    } catch (error) {
      if (error instanceof HubError) throw error;
      return configError(`无法读取 package.json：${directory}`, 400);
    }

    const rawScripts = manifest.scripts;
    const scripts = rawScripts && typeof rawScripts === "object" && !Array.isArray(rawScripts)
      ? Object.entries(rawScripts)
          .filter((entry): entry is [string, string] => {
            return typeof entry[1] === "string" && Boolean(entry[1].trim());
          })
          .map(([name]) => name)
          .sort((left, right) => {
            const rank = (name: string) => name === "dev" ? 0 : name === "start" ? 1 : 2;
            return rank(left) - rank(right) || left.localeCompare(right);
          })
      : [];
    if (!scripts.length) {
      return configError(`项目没有可启动的 package.json scripts：${directory}`, 400);
    }

    const productName = typeof manifest.productName === "string" ? manifest.productName.trim() : "";
    const packageName = typeof manifest.name === "string" ? manifest.name.trim() : "";
    return {
      name: productName || packageName || path.basename(directory),
      directory,
      scripts,
      packageManager: packageManager(directory, manifest),
      configured: this.#projects.some((project) => project.directory === directory),
    };
  }

  add(
    directory: string,
    scriptInput: string,
    reservedServiceIds: ReadonlySet<string>,
    nameInput?: string,
  ): { readonly project: LocalNodeProject; readonly definition: ServiceDefinition } {
    const candidate = this.inspect(directory);
    if (candidate.configured) {
      throw new HubError(
        "PROJECT_ALREADY_CONFIGURED",
        "该本地项目已经加入启动列表",
        409,
      );
    }
    const script = stringValue(scriptInput, "script");
    if (!candidate.scripts.includes(script)) {
      throw new HubError("SCRIPT_NOT_FOUND", `package.json 中不存在 script：${script}`, 400);
    }

    const id = uniqueId(
      `local-${slug(candidate.name)}`,
      new Set(this.#projects.map((project) => project.id)),
    );
    const serviceId = uniqueId(`${id}-${slug(script)}`, reservedServiceIds);
    const project: LocalNodeProject = {
      id,
      serviceId,
      name: projectName(nameInput, candidate.name),
      directory: candidate.directory,
      script,
      packageManager: candidate.packageManager,
      createdAt: new Date().toISOString(),
    };
    this.#projects = [...this.#projects, project];
    this.#save();
    return { project, definition: serviceDefinition(project) };
  }

  update(
    projectId: string,
    directory: string,
    scriptInput: string,
    nameInput?: string,
  ): { readonly project: LocalNodeProject; readonly definition: ServiceDefinition } {
    const index = this.#projects.findIndex((project) => project.id === projectId);
    if (index < 0) throw new HubError("PROJECT_NOT_FOUND", `未知本机项目：${projectId}`, 404);
    const previous = this.#projects[index];
    const candidate = this.inspect(directory);
    if (this.#projects.some((project) => project.id !== projectId && project.directory === candidate.directory)) {
      throw new HubError("PROJECT_ALREADY_CONFIGURED", "该本地项目已经加入启动列表", 409);
    }
    const script = stringValue(scriptInput, "script");
    if (!candidate.scripts.includes(script)) {
      throw new HubError("SCRIPT_NOT_FOUND", `package.json 中不存在 script：${script}`, 400);
    }
    const project: LocalNodeProject = {
      ...previous,
      name: projectName(nameInput, candidate.name),
      directory: candidate.directory,
      script,
      packageManager: candidate.packageManager,
    };
    this.#projects = this.#projects.map((item, itemIndex) => itemIndex === index ? project : item);
    this.#save();
    return { project, definition: serviceDefinition(project) };
  }

  remove(projectId: string): LocalNodeProject {
    const project = this.#projects.find((item) => item.id === projectId);
    if (!project) throw new HubError("PROJECT_NOT_FOUND", `未知本机项目：${projectId}`, 404);
    this.#projects = this.#projects.filter((item) => item.id !== projectId);
    this.#save();
    return project;
  }

  exportDocument(): LocalProjectTransferDocument {
    return {
      format: "phoenix-hub-projects",
      version: 1,
      projects: this.#projects.map(({ name, directory, script }) => ({ name, directory, script })),
    };
  }

  prepareImport(value: unknown, reservedServiceIds: ReadonlySet<string>): PnhProjectImportPlan {
    const root = objectValue(value, "导入配置");
    if (root.format !== "phoenix-hub-projects" || root.version !== 1 || !Array.isArray(root.projects)) {
      return configError("导入配置必须使用 phoenix-hub-projects version=1 格式", 400);
    }
    if (root.projects.length > MAX_IMPORTED_PROJECTS) {
      return configError(`一次最多导入 ${MAX_IMPORTED_PROJECTS} 个项目`, 400);
    }

    const projects = [...this.#projects];
    const existingByDirectory = new Map(projects.map((project) => [project.directory, project]));
    const usedProjectIds = new Set(projects.map((project) => project.id));
    const usedServiceIds = new Set(reservedServiceIds);
    const importedDirectories = new Set<string>();
    const added: PnhProjectImportChange[] = [];
    const updated: PnhProjectImportChange[] = [];

    for (const raw of root.projects) {
      const item = objectValue(raw, "导入项目");
      const candidate = this.inspect(stringValue(item.directory, "导入项目 directory"));
      if (importedDirectories.has(candidate.directory)) {
        return configError(`导入配置包含重复目录：${candidate.directory}`, 400);
      }
      importedDirectories.add(candidate.directory);
      const script = stringValue(item.script, "导入项目 script");
      if (!candidate.scripts.includes(script)) {
        throw new HubError("SCRIPT_NOT_FOUND", `package.json 中不存在 script：${script}`, 400);
      }
      const name = projectName(item.name, candidate.name);
      const existing = existingByDirectory.get(candidate.directory);
      if (existing) {
        const project: LocalNodeProject = {
          ...existing,
          name,
          script,
          packageManager: candidate.packageManager,
        };
        const index = projects.findIndex((entry) => entry.id === existing.id);
        projects[index] = project;
        if (
          project.name !== existing.name
          || project.script !== existing.script
          || project.packageManager !== existing.packageManager
        ) updated.push({ project, definition: serviceDefinition(project) });
        continue;
      }

      const id = uniqueId(`local-${slug(name)}`, usedProjectIds);
      usedProjectIds.add(id);
      const serviceId = uniqueId(`${id}-${slug(script)}`, usedServiceIds);
      usedServiceIds.add(serviceId);
      const project: LocalNodeProject = {
        id,
        serviceId,
        name,
        directory: candidate.directory,
        script,
        packageManager: candidate.packageManager,
        createdAt: new Date().toISOString(),
      };
      projects.push(project);
      existingByDirectory.set(project.directory, project);
      added.push({ project, definition: serviceDefinition(project) });
    }

    return { projects, added, updated };
  }

  commitImport(plan: PnhProjectImportPlan): void {
    this.#projects = [...plan.projects];
    this.#save();
  }

  #discover(): readonly LocalNodeProjectCandidate[] {
    const result: LocalNodeProjectCandidate[] = [];
    for (const entry of readdirSync(this.#defaultRoot, { withFileTypes: true })) {
      if (
        !entry.isDirectory()
        || entry.name.startsWith(".")
        || entry.name === path.basename(this.#projectRoot)
      ) continue;
      const directory = path.join(this.#defaultRoot, entry.name);
      if (!existsSync(path.join(directory, "package.json"))) continue;
      try {
        result.push(this.inspect(directory));
      } catch {
        // 损坏或没有 scripts 的目录不进入候选；手工检查会返回具体原因。
      }
    }
    return result.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  }

  #load(): LocalNodeProject[] {
    if (!existsSync(this.#configPath)) return [];
    let root: Record<string, unknown>;
    try {
      root = objectValue(
        JSON.parse(readFileSync(this.#configPath, "utf8")) as unknown,
        "本机项目配置",
      );
    } catch (error) {
      if (error instanceof HubError) throw error;
      return configError("本机项目配置不是合法 JSON");
    }
    if (root.version !== 1 || !Array.isArray(root.projects)) {
      return configError("本机项目配置必须使用 version=1 与 projects 数组");
    }
    const projects = root.projects.map((raw): LocalNodeProject => {
      const value = objectValue(raw, "本机项目");
      const id = stringValue(value.id, "本机项目 id");
      const serviceId = stringValue(value.serviceId, "本机项目 serviceId");
      const manager = stringValue(value.packageManager, "本机项目 packageManager");
      if (!ID_PATTERN.test(id) || !ID_PATTERN.test(serviceId)) {
        return configError("本机项目 ID 不合法");
      }
      if (!PACKAGE_MANAGERS.has(manager as NodePackageManager)) {
        return configError(`不支持的包管理器：${manager}`);
      }
      return {
        id,
        serviceId,
        name: stringValue(value.name, "本机项目 name"),
        directory: stringValue(value.directory, "本机项目 directory"),
        script: stringValue(value.script, "本机项目 script"),
        packageManager: manager as NodePackageManager,
        createdAt: stringValue(value.createdAt, "本机项目 createdAt"),
      };
    });
    if (
      new Set(projects.map((project) => project.id)).size !== projects.length
      || new Set(projects.map((project) => project.serviceId)).size !== projects.length
    ) return configError("本机项目配置存在重复 ID");
    return projects;
  }

  #save(): void {
    const directory = path.dirname(this.#configPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#configPath}.${process.pid}.tmp`;
    const content: LocalProjectFile = { version: 1, projects: this.#projects };
    writeFileSync(temporaryPath, `${JSON.stringify(content, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.#configPath);
  }
}
