import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import type { ProcessSummary, ServiceDefinition } from "../shared/contracts.js";

export interface PnhPersistedOwnership {
  readonly serviceId: string;
  readonly ownershipId: string;
  readonly root: ProcessSummary;
  readonly startedAt: string;
  readonly ports: readonly number[];
  readonly definitionIdentity: string;
}

interface PnhOwnershipFile {
  readonly version: 1;
  readonly records: readonly PnhPersistedOwnership[];
}

function processSummary(value: unknown): ProcessSummary | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    !Number.isInteger(item.pid)
    || !Number.isInteger(item.processGroupId)
    || typeof item.startedAt !== "string"
    || !item.startedAt
  ) return undefined;
  return {
    pid: item.pid as number,
    ...(Number.isInteger(item.parentPid) ? { parentPid: item.parentPid as number } : {}),
    processGroupId: item.processGroupId as number,
    ...(Number.isInteger(item.sessionId) ? { sessionId: item.sessionId as number } : {}),
    ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}),
    ...(typeof item.command === "string" ? { command: item.command } : {}),
    startedAt: item.startedAt,
    ...(typeof item.tty === "string" ? { tty: item.tty } : {}),
  };
}

function ownershipRecord(value: unknown): PnhPersistedOwnership | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const root = processSummary(item.root);
  if (
    typeof item.serviceId !== "string"
    || !item.serviceId
    || typeof item.ownershipId !== "string"
    || !item.ownershipId
    || typeof item.startedAt !== "string"
    || !item.startedAt
    || typeof item.definitionIdentity !== "string"
    || !item.definitionIdentity
    || !Array.isArray(item.ports)
    || item.ports.some((port) => !Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535)
    || !root
  ) return undefined;
  return {
    serviceId: item.serviceId,
    ownershipId: item.ownershipId,
    root,
    startedAt: item.startedAt,
    ports: [...new Set(item.ports as number[])].sort((left, right) => left - right),
    definitionIdentity: item.definitionIdentity,
  };
}

export function pnhServiceDefinitionIdentity(definition: ServiceDefinition): string {
  const stableDefinition = JSON.stringify({
    id: definition.id,
    cwd: path.resolve(definition.cwd),
    command: {
      executable: definition.command.executable,
      args: [...definition.command.args],
      env: Object.entries(definition.command.env ?? {}).sort(([left], [right]) => left.localeCompare(right)),
    },
    endpoints: definition.endpoints
      .map((endpoint) => ({
        id: endpoint.id,
        port: endpoint.port,
        healthUrl: endpoint.healthUrl,
        required: endpoint.required !== false,
      }))
      .sort((left, right) => left.id.localeCompare(right.id) || left.port - right.port),
  });
  return `sha256:${createHash("sha256").update(stableDefinition).digest("hex")}`;
}

export interface PnhServiceOwnershipPersistence {
  entries(): readonly PnhPersistedOwnership[];
  put(record: PnhPersistedOwnership): void;
  delete(serviceId: string, ownershipId?: string): void;
}

export class PnhMemoryServiceOwnershipStore implements PnhServiceOwnershipPersistence {
  readonly #records = new Map<string, PnhPersistedOwnership>();

  constructor(records: readonly PnhPersistedOwnership[] = []) {
    for (const record of records) this.#records.set(record.serviceId, record);
  }

  entries(): readonly PnhPersistedOwnership[] {
    return [...this.#records.values()];
  }

  put(record: PnhPersistedOwnership): void {
    this.#records.set(record.serviceId, record);
  }

  delete(serviceId: string, ownershipId?: string): void {
    const current = this.#records.get(serviceId);
    if (!current || (ownershipId && current.ownershipId !== ownershipId)) return;
    this.#records.delete(serviceId);
  }
}

/** 在 Git 忽略的 .runtime 中原子保存 Hub-owned 根进程身份。 */
export class PnhServiceOwnershipStore implements PnhServiceOwnershipPersistence {
  readonly #file: string;
  readonly #records = new Map<string, PnhPersistedOwnership>();

  constructor(projectRoot: string) {
    this.#file = path.join(path.resolve(projectRoot), ".runtime/ownership.json");
    this.#load();
  }

  entries(): readonly PnhPersistedOwnership[] {
    return [...this.#records.values()];
  }

  put(record: PnhPersistedOwnership): void {
    this.#records.set(record.serviceId, record);
    this.#save();
  }

  delete(serviceId: string, ownershipId?: string): void {
    const current = this.#records.get(serviceId);
    if (!current || (ownershipId && current.ownershipId !== ownershipId)) return;
    this.#records.delete(serviceId);
    this.#save();
  }

  #load(): void {
    if (!existsSync(this.#file)) return;
    try {
      const document = JSON.parse(readFileSync(this.#file, "utf8")) as Partial<PnhOwnershipFile>;
      if (document.version !== 1 || !Array.isArray(document.records)) return;
      for (const value of document.records) {
        const record = ownershipRecord(value);
        if (record) this.#records.set(record.serviceId, record);
      }
    } catch {
      // 损坏或不可信记录不会阻止 Hub 启动，也不会恢复 ownership。
    }
  }

  #save(): void {
    const directory = path.dirname(this.#file);
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (this.#records.size === 0) {
      if (existsSync(this.#file)) unlinkSync(this.#file);
      return;
    }
    const temporary = `${this.#file}.${process.pid}.tmp`;
    const document: PnhOwnershipFile = { version: 1, records: this.entries() };
    try {
      writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, {
        encoding: "utf8",
        mode: 0o600,
      });
      renameSync(temporary, this.#file);
    } finally {
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
}
