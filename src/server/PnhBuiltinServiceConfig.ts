import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import type {
  BuiltinServiceConfigCatalogResponse,
  ServiceConfigurationFileV2,
  ServiceDefinition,
  ServiceSeriesSource,
  ServiceSourceDefinition,
} from "../shared/contracts.js";
import {
  configurationFromDefinitions,
  mergeServiceSource,
  parseServiceDefinition,
  resolveServiceConfiguration,
  serviceSourceFromDefinition,
  type LoadedServiceConfiguration,
} from "./config.js";
import { HubError } from "./errors.js";

interface RuntimeServiceFileV1 {
  readonly version: 1;
  readonly overrides: readonly ServiceDefinition[];
  readonly removed: readonly string[];
}

interface RuntimeServiceFileV2 {
  readonly version: 2;
  readonly seriesOverrides: readonly ServiceSeriesSource[];
  readonly removed: readonly string[];
}

interface RuntimeServiceFileV3 {
  readonly version: 3;
  readonly seriesOverrides: readonly ServiceSeriesSource[];
  readonly baselineProfileIds: Readonly<Record<string, readonly string[]>>;
  readonly removed: readonly string[];
}

export interface PnhBuiltinImportPlan {
  readonly definitions: readonly ServiceDefinition[];
}

export interface PnhBuiltinSeriesImportPlan {
  readonly series: readonly ServiceSeriesSource[];
  readonly hiddenServiceIds: readonly string[];
}

function configError(message: string, statusCode = 500): never {
  throw new HubError("INVALID_BUILTIN_SERVICE_CONFIG", message, statusCode);
}

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function cleanDefinition(definition: ServiceDefinition): ServiceDefinition {
  const {
    configurationSource: _configurationSource,
    configurationOverridden: _configurationOverridden,
    localProjectId: _localProjectId,
    ...clean
  } = definition;
  return clean;
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** 只保留相对模板发生变化的字段；数组采用整体替换。 */
function sourceDifference(base: unknown, effective: unknown): unknown {
  if (sameJson(base, effective)) return undefined;
  if (!isPlainObject(base) || !isPlainObject(effective)) return cloneJson(effective);
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(effective)) {
    const difference = sourceDifference(base[key], value);
    if (difference !== undefined) result[key] = difference;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function mergeBaselineSeries(
  baseline: ServiceSeriesSource,
  candidate: ServiceSeriesSource,
  previousBaselineProfileIds: ReadonlySet<string> | undefined,
): ServiceSeriesSource {
  const templateRoles = new Set([
    ...Object.keys(baseline.template.services),
    ...Object.keys(candidate.template.services),
  ]);
  const templateServices = Object.fromEntries([...templateRoles].map((role) => [
    role,
    mergeServiceSource(baseline.template.services[role], candidate.template.services[role] ?? {}),
  ]));
  const candidateProfiles = new Map(candidate.profiles.map((profile) => [profile.id, profile]));
  const profiles = baseline.profiles.flatMap((baseProfile) => {
    const override = candidateProfiles.get(baseProfile.id);
    if (!override) {
      return previousBaselineProfileIds?.has(baseProfile.id) ? [] : [cloneJson(baseProfile)];
    }
    candidateProfiles.delete(baseProfile.id);
    const roles = new Set([...Object.keys(baseProfile.services), ...Object.keys(override.services)]);
    const services = Object.fromEntries([...roles].map((role) => {
      const candidateService = override.services[role];
      if (candidateService === false) return [role, false];
      const baselineService = baseProfile.services[role];
      return [role, mergeServiceSource(
        baselineService === false ? undefined : baselineService,
        candidateService ?? {},
      )];
    }));
    let policy = override.policy ?? baseProfile.policy;
    if (!override.policy && policy) {
      const role = policy.database.serviceRole;
      const source = services[role];
      if (source !== false) {
        const effective = mergeServiceSource(templateServices[role], source ?? {});
        const databaseName = effective.command?.env?.[policy.database.envName];
        if (databaseName) {
          policy = {
            ...policy,
            database: { ...policy.database, name: databaseName },
          };
        }
      }
    }
    return [{
      ...baseProfile,
      ...override,
      metadata: { ...baseProfile.metadata, ...override.metadata },
      ...(policy ? { policy } : {}),
      services,
    }];
  });
  profiles.push(...[...candidateProfiles.values()].map(cloneJson));
  return {
    ...baseline,
    ...candidate,
    template: {
      ...baseline.template,
      ...candidate.template,
      services: templateServices,
    },
    profiles,
  };
}

/**
 * 旧本机覆盖只可继承非安全字段；发布验收的数据库与不可变装配身份永远由当前仓库 baseline 锚定。
 * 该迁移仅在内存中发生，不会静默重写用户的 .runtime/services.json。
 */
function anchorReleaseValidationPolicies(
  baseline: ServiceSeriesSource,
  candidate: unknown,
): ServiceSeriesSource {
  if (!isPlainObject(candidate) || !Array.isArray(candidate.profiles)) {
    return candidate as ServiceSeriesSource;
  }
  const baselineProfiles = new Map(baseline.profiles.map((profile) => [profile.id, profile]));
  return {
    ...candidate,
    profiles: candidate.profiles.map((rawProfile) => {
      if (!isPlainObject(rawProfile) || typeof rawProfile.id !== "string") return rawProfile;
      const baselineProfile = baselineProfiles.get(rawProfile.id);
      if (baselineProfile?.policy?.environmentKind !== "release-validation") return rawProfile;
      const displayMetadata = isPlainObject(rawProfile.metadata)
        ? Object.fromEntries(Object.entries(rawProfile.metadata).filter(([, value]) => typeof value === "string"))
        : {};
      return {
        ...cloneJson(baselineProfile),
        ...(typeof rawProfile.name === "string" ? { name: rawProfile.name } : {}),
        metadata: { ...baselineProfile.metadata, ...displayMetadata },
        policy: cloneJson(baselineProfile.policy),
        services: cloneJson(baselineProfile.services),
      };
    }),
  } as unknown as ServiceSeriesSource;
}

/** 保存内置 Series/Profile 覆盖与隐藏状态，仓库 version 2 清单始终作为可恢复基线。 */
export class PnhBuiltinServiceConfigStore {
  readonly #projectRoot: string;
  readonly #configPath: string;
  readonly #baselineSource: ServiceConfigurationFileV2;
  readonly #baselineSeries: ReadonlyMap<string, ServiceSeriesSource>;
  readonly #seriesOrder: readonly string[];
  #seriesOverrides = new Map<string, ServiceSeriesSource>();
  #removed = new Set<string>();

  constructor(
    projectRoot: string,
    baseline: LoadedServiceConfiguration | readonly ServiceDefinition[],
  ) {
    this.#projectRoot = path.resolve(projectRoot);
    this.#configPath = path.join(this.#projectRoot, ".runtime/services.json");
    this.#baselineSource = "source" in baseline
      ? cloneJson(baseline.source)
      : configurationFromDefinitions(baseline);
    this.#baselineSeries = new Map(this.#baselineSource.series.map((series) => [series.id, series]));
    this.#seriesOrder = this.#baselineSource.series.map((series) => series.id);
    this.#load();
  }

  sourceDocument(): ServiceConfigurationFileV2 {
    const ordered = this.#seriesOrder.map((id) => this.#seriesOverrides.get(id) ?? this.#baselineSeries.get(id)!);
    const added = [...this.#seriesOverrides.entries()]
      .filter(([id]) => !this.#baselineSeries.has(id))
      .map(([, series]) => series);
    return { version: 2, series: cloneJson([...ordered, ...added]) };
  }

  hiddenServiceIds(): readonly string[] {
    return [...this.#removed];
  }

  allDefinitions(): readonly ServiceDefinition[] {
    return resolveServiceConfiguration(this.sourceDocument(), this.#projectRoot, {
      tolerateUnavailablePaths: true,
    });
  }

  effectiveDefinitions(): readonly ServiceDefinition[] {
    const baselineById = new Map(
      resolveServiceConfiguration(this.#baselineSource, this.#projectRoot, {
        tolerateUnavailablePaths: true,
      }).map((definition) => [definition.id, definition]),
    );
    return this.allDefinitions()
      .filter((definition) => !this.#removed.has(definition.id))
      .map((definition) => this.#decorate(
        definition,
        !sameJson(cleanDefinition(definition), cleanDefinition(baselineById.get(definition.id) ?? definition))
          || !baselineById.has(definition.id),
      ));
  }

  catalog(): BuiltinServiceConfigCatalogResponse {
    const baselineDefinitions = resolveServiceConfiguration(this.#baselineSource, this.#projectRoot, {
      tolerateUnavailablePaths: true,
    });
    const baselineById = new Map(baselineDefinitions.map((definition) => [definition.id, definition]));
    const currentDefinitions = this.allDefinitions();
    const currentById = new Map(currentDefinitions.map((definition) => [definition.id, definition]));
    const ids = [
      ...baselineDefinitions.map((definition) => definition.id),
      ...currentDefinitions.filter((definition) => !baselineById.has(definition.id)).map((definition) => definition.id),
    ];
    const source = this.sourceDocument();
    return {
      services: ids.map((id) => {
        const baseline = baselineById.get(id) ?? currentById.get(id)!;
        const current = currentById.get(id);
        const overridden = !baselineById.has(id)
          || Boolean(current && !sameJson(cleanDefinition(current), cleanDefinition(baseline)));
        const removed = this.#removed.has(id);
        return {
          id,
          source: "builtin" as const,
          removed,
          overridden,
          baseline: this.#decorate(baseline, false),
          definition: removed || !current ? undefined : this.#decorate(current, overridden),
        };
      }),
      series: source.series.map((series) => {
        const baseline = this.#baselineSeries.get(series.id) ?? series;
        const definitions = currentDefinitions
          .filter((definition) => definition.seriesId === series.id)
          .map((definition) => {
            const baselineDefinition = baselineById.get(definition.id);
            return this.#decorate(definition, !baselineDefinition
              || !sameJson(cleanDefinition(definition), cleanDefinition(baselineDefinition)));
          });
        return {
          id: series.id,
          source: "builtin" as const,
          overridden: !this.#baselineSeries.has(series.id) || !sameJson(series, baseline),
          baseline: cloneJson(baseline),
          definition: cloneJson(series),
          services: definitions,
        };
      }),
    };
  }

  update(serviceId: string, value: unknown): ServiceDefinition {
    const current = this.allDefinitions().find((definition) => definition.id === serviceId);
    if (!current) throw new HubError("BUILTIN_SERVICE_NOT_FOUND", `未知内置服务：${serviceId}`, 404);
    const definition = this.#parseDefinition(value);
    if (definition.id !== serviceId) return configError("内置服务 ID 不可修改", 400);
    this.#setServiceOverride(current, definition);
    this.#removed.delete(serviceId);
    this.#save();
    return this.effectiveDefinitions().find((item) => item.id === serviceId)!;
  }

  updateSeries(seriesId: string, value: unknown): readonly ServiceDefinition[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return configError("Series 配置必须是 JSON 对象", 400);
    }
    const candidate = cloneJson(value) as ServiceSeriesSource;
    if (candidate.id !== seriesId) return configError("Series ID 不可修改", 400);
    const currentDocument = this.sourceDocument();
    const existingIndex = currentDocument.series.findIndex((series) => series.id === seriesId);
    if (existingIndex < 0) throw new HubError("BUILTIN_SERIES_NOT_FOUND", `未知 Series：${seriesId}`, 404);
    const nextSeries = [...currentDocument.series];
    nextSeries[existingIndex] = candidate;
    const normalized = this.#validateSource({ version: 2, series: nextSeries });
    const normalizedSeries = normalized.source.series.find((series) => series.id === seriesId)!;
    const baseline = this.#baselineSeries.get(seriesId);
    if (baseline && sameJson(normalizedSeries, baseline)) this.#seriesOverrides.delete(seriesId);
    else this.#seriesOverrides.set(seriesId, normalizedSeries);
    const validIds = new Set(normalized.definitions.map((definition) => definition.id));
    this.#removed = new Set([...this.#removed].filter((id) => validIds.has(id)));
    this.#save();
    return this.effectiveDefinitions().filter((definition) => definition.seriesId === seriesId);
  }

  remove(serviceId: string): ServiceDefinition {
    const current = this.effectiveDefinitions().find((definition) => definition.id === serviceId);
    if (!this.allDefinitions().some((definition) => definition.id === serviceId)) {
      throw new HubError("BUILTIN_SERVICE_NOT_FOUND", `未知内置服务：${serviceId}`, 404);
    }
    if (!current) throw new HubError("BUILTIN_SERVICE_REMOVED", "该默认服务已隐藏", 409);
    const baseline = resolveServiceConfiguration(this.#baselineSource, this.#projectRoot, {
      tolerateUnavailablePaths: true,
    })
      .find((definition) => definition.id === serviceId);
    if (baseline) this.#setServiceOverride(current, baseline);
    this.#removed.add(serviceId);
    this.#save();
    return current;
  }

  restore(serviceId: string): ServiceDefinition {
    const definition = this.allDefinitions().find((item) => item.id === serviceId);
    if (!definition) throw new HubError("BUILTIN_SERVICE_NOT_FOUND", `未知内置服务：${serviceId}`, 404);
    if (!this.#removed.has(serviceId)) {
      throw new HubError("BUILTIN_SERVICE_NOT_REMOVED", "该默认服务当前未隐藏", 409);
    }
    this.#removed.delete(serviceId);
    this.#save();
    return this.effectiveDefinitions().find((item) => item.id === serviceId)!;
  }

  reset(): readonly ServiceDefinition[] {
    this.#seriesOverrides.clear();
    this.#removed.clear();
    this.#save();
    return this.effectiveDefinitions();
  }

  prepareImport(values: readonly unknown[]): PnhBuiltinImportPlan {
    const knownIds = new Set(this.allDefinitions().map((definition) => definition.id));
    const seen = new Set<string>();
    const definitions = values.map((value) => {
      const definition = this.#parseDefinition(value);
      if (!knownIds.has(definition.id)) return configError(`导入配置包含未知内置服务：${definition.id}`, 400);
      if (seen.has(definition.id)) return configError(`导入配置包含重复服务：${definition.id}`, 400);
      seen.add(definition.id);
      return definition;
    });
    return { definitions };
  }

  commitImport(plan: PnhBuiltinImportPlan): readonly ServiceDefinition[] {
    for (const definition of plan.definitions) {
      const current = this.allDefinitions().find((item) => item.id === definition.id)!;
      this.#setServiceOverride(current, definition);
      this.#removed.delete(definition.id);
    }
    this.#save();
    return plan.definitions.map((definition) => this.effectiveDefinitions().find(
      (item) => item.id === definition.id,
    )!);
  }

  prepareSeriesImport(
    series: readonly unknown[],
    hiddenServiceIds: readonly unknown[] = [],
  ): PnhBuiltinSeriesImportPlan {
    const source = this.#validateSource({
      version: 2,
      series: series as readonly ServiceSeriesSource[],
    }).source;
    const validIds = new Set(resolveServiceConfiguration(source, this.#projectRoot).map((definition) => definition.id));
    const hidden = hiddenServiceIds.map((value) => {
      if (typeof value !== "string" || !validIds.has(value)) {
        return configError(`导入配置包含未知隐藏服务：${String(value)}`, 400);
      }
      return value;
    });
    return { series: source.series, hiddenServiceIds: hidden };
  }

  commitSeriesImport(plan: PnhBuiltinSeriesImportPlan): readonly ServiceDefinition[] {
    for (const series of plan.series) {
      const baseline = this.#baselineSeries.get(series.id);
      if (baseline && sameJson(series, baseline)) this.#seriesOverrides.delete(series.id);
      else this.#seriesOverrides.set(series.id, cloneJson(series));
    }
    this.#removed = new Set(plan.hiddenServiceIds);
    this.#save();
    return this.effectiveDefinitions();
  }

  #setServiceOverride(
    current: ServiceDefinition,
    input: ServiceDefinition,
    tolerateUnavailablePaths = false,
  ): void {
    const seriesId = current.seriesId ?? current.moduleId;
    const profileId = current.profileId ?? "default";
    const role = current.serviceRole ?? current.id;
    const source = this.sourceDocument();
    const series = source.series.find((item) => item.id === seriesId);
    const profile = series?.profiles.find((item) => item.id === profileId);
    if (!series || !profile) return configError(`无法定位服务 ${current.id} 的 Series/Profile`, 500);
    const fullSource = serviceSourceFromDefinition(input);
    const template = series.template.services[role] ?? {};
    const difference = sourceDifference(template, fullSource) as ServiceSourceDefinition | undefined;
    const nextProfile = {
      ...profile,
      services: { ...profile.services, [role]: difference ?? {} },
    };
    const nextSeries = {
      ...series,
      profiles: series.profiles.map((item) => item.id === profileId ? nextProfile : item),
    };
    const baseline = this.#baselineSeries.get(seriesId);
    if (baseline && sameJson(nextSeries, baseline)) this.#seriesOverrides.delete(seriesId);
    else this.#seriesOverrides.set(seriesId, nextSeries);
    this.#validateSource(this.sourceDocument(), tolerateUnavailablePaths);
  }

  #decorate(definition: ServiceDefinition, overridden: boolean): ServiceDefinition {
    return {
      ...cleanDefinition(definition),
      configurationSource: "builtin",
      configurationOverridden: overridden,
    };
  }

  #parseDefinition(value: unknown, tolerateUnavailablePaths = false): ServiceDefinition {
    try {
      return cleanDefinition(parseServiceDefinition(value, this.#projectRoot, {
        allowMissingCwd: tolerateUnavailablePaths,
      }));
    } catch (error) {
      if (error instanceof HubError) {
        throw new HubError("INVALID_BUILTIN_SERVICE_CONFIG", error.message, 400, error.details);
      }
      throw error;
    }
  }

  #validateSource(
    source: ServiceConfigurationFileV2,
    tolerateUnavailablePaths = false,
  ): LoadedServiceConfiguration {
    try {
      const definitions = resolveServiceConfiguration(source, this.#projectRoot, {
        tolerateUnavailablePaths,
      });
      return { source: cloneJson(source), definitions };
    } catch (error) {
      if (error instanceof HubError) {
        throw new HubError("INVALID_BUILTIN_SERVICE_CONFIG", error.message, 400, error.details);
      }
      throw error;
    }
  }

  #load(): void {
    if (!existsSync(this.#configPath)) return;
    let file: RuntimeServiceFileV1 | RuntimeServiceFileV2 | RuntimeServiceFileV3;
    try {
      file = JSON.parse(readFileSync(this.#configPath, "utf8")) as RuntimeServiceFileV1 | RuntimeServiceFileV2 | RuntimeServiceFileV3;
    } catch {
      return configError("本机内置服务覆盖不是合法 JSON");
    }
    if (file.version === 1) {
      if (!Array.isArray(file.overrides) || !Array.isArray(file.removed)) {
        return configError("version=1 本机覆盖缺少 overrides 或 removed");
      }
      for (const raw of file.overrides) {
        const definition = this.#parseDefinition(raw, true);
        const current = this.allDefinitions().find((item) => item.id === definition.id);
        if (!current) return configError(`覆盖了未知内置服务：${definition.id}`);
        this.#setServiceOverride(current, definition, true);
      }
      this.#removed = new Set(file.removed);
      return;
    }
    if ((file.version !== 2 && file.version !== 3) || !Array.isArray(file.seriesOverrides) || !Array.isArray(file.removed)) {
      return configError("本机内置服务覆盖必须使用 version=2/3、seriesOverrides 与 removed");
    }
    if (file.version === 3 && (!file.baselineProfileIds || typeof file.baselineProfileIds !== "object")) {
      return configError("version=3 本机覆盖缺少 baselineProfileIds");
    }
    for (const raw of file.seriesOverrides) {
      if (!isPlainObject(raw) || typeof raw.id !== "string") {
        return configError("本机 Series 覆盖缺少合法 id");
      }
      const baseline = this.#baselineSeries.get(raw.id);
      const anchored = baseline
        ? anchorReleaseValidationPolicies(baseline, raw)
        : raw as unknown as ServiceSeriesSource;
      const candidate = this.#validateSource(
        { version: 2, series: [anchored] },
        true,
      ).source.series[0]!;
      const previousIds = file.version === 3
        ? file.baselineProfileIds[candidate.id]
        : undefined;
      if (file.version === 3 && previousIds && !Array.isArray(previousIds)) {
        return configError(`version=3 的 ${candidate.id} baselineProfileIds 不合法`);
      }
      const previousIdSet = previousIds ? new Set(previousIds) : undefined;
      const hasNewBaselineProfile = Boolean(
        baseline && previousIdSet && baseline.profiles.some((profile) => !previousIdSet.has(profile.id)),
      );
      this.#seriesOverrides.set(candidate.id, baseline && (file.version === 2 || hasNewBaselineProfile)
        ? mergeBaselineSeries(baseline, candidate, previousIdSet)
        : candidate);
    }
    const validIds = new Set(this.allDefinitions().map((definition) => definition.id));
    for (const id of file.removed) {
      if (typeof id !== "string" || !validIds.has(id)) return configError(`隐藏了未知内置服务：${id}`);
      this.#removed.add(id);
    }
  }

  #save(): void {
    const directory = path.dirname(this.#configPath);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const temporaryPath = `${this.#configPath}.${process.pid}.tmp`;
    const content: RuntimeServiceFileV3 = {
      version: 3,
      seriesOverrides: [...this.#seriesOverrides.values()].map(cloneJson),
      baselineProfileIds: Object.fromEntries([...this.#baselineSeries.entries()].map(([id, series]) => [
        id,
        series.profiles.map((profile) => profile.id),
      ])),
      removed: [...this.#removed],
    };
    writeFileSync(temporaryPath, `${JSON.stringify(content, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temporaryPath, this.#configPath);
  }
}
