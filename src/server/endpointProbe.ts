import net from "node:net";
import type {
  EndpointStatus,
  ServiceEndpointDefinition,
  ServiceIdentityDefinition,
} from "../shared/contracts.js";
import { listenerPids } from "./processDiscovery.js";

export function probePort(port: number, timeoutMs = 600): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: "127.0.0.1", port });
    const finish = (reachable: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

async function probeHealth(url: string): Promise<{ healthy: boolean | null; statusCode?: number }> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(1_200),
      redirect: "manual",
      headers: { "user-agent": "phoenix-hub/0.1" },
    });
    const parsed = new URL(url);
    const rootRouteMissing = response.status === 404
      && parsed.pathname === "/"
      && !parsed.search
      && !parsed.hash;
    return {
      healthy: rootRouteMissing ? null : response.status >= 200 && response.status < 300,
      statusCode: response.status,
    };
  } catch {
    return { healthy: false };
  }
}

export interface IdentityProbeResult {
  readonly matched: boolean | null;
  readonly statusCode?: number;
  readonly message?: string;
}

export async function probeServiceIdentity(
  identity: ServiceIdentityDefinition | undefined,
): Promise<IdentityProbeResult> {
  if (!identity) return { matched: null, message: "未配置 HTTP 身份证明" };
  try {
    const response = await fetch(identity.url, {
      signal: AbortSignal.timeout(1_200),
      redirect: "manual",
      headers: { "user-agent": "phoenix-hub/0.1" },
    });
    if (response.status < 200 || response.status >= 300) {
      return {
        matched: false,
        statusCode: response.status,
        message: `身份端点返回 HTTP ${response.status}`,
      };
    }
    const body = await response.json() as unknown;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return { matched: false, statusCode: response.status, message: "身份端点未返回 JSON 对象" };
    }
    const record = body as Record<string, unknown>;
    const mismatch = Object.entries(identity.expected).find(([key, expected]) => record[key] !== expected);
    return mismatch
      ? {
          matched: false,
          statusCode: response.status,
          message: `身份字段 ${mismatch[0]} 不匹配`,
        }
      : { matched: true, statusCode: response.status };
  } catch {
    return { matched: false, message: "身份端点不可用" };
  }
}

export async function probeEndpoint(
  endpoint: ServiceEndpointDefinition,
): Promise<EndpointStatus> {
  const [reachable, pids] = await Promise.all([
    probePort(endpoint.port),
    listenerPids(endpoint.port),
  ]);
  const health: { healthy: boolean | null; statusCode?: number } = endpoint.healthUrl && reachable
    ? await probeHealth(endpoint.healthUrl)
    : { healthy: endpoint.healthUrl ? false : null };
  const probeState: EndpointStatus["probeState"] = !reachable
    ? "unreachable"
      : !endpoint.healthUrl || health.healthy === null
      ? "reachable-unverified"
      : health.healthy
        ? "healthy"
        : "unhealthy";
  const probeMessage = probeState === "unreachable"
    ? "端口不可达"
    : probeState === "reachable-unverified"
      ? endpoint.healthUrl && health.statusCode === 404
        ? "端口可达；配置的根路径返回 HTTP 404，未发现可用健康路径"
        : "端口可达；未配置 HTTP 健康路径"
      : probeState === "healthy"
        ? `健康路径返回 HTTP ${health.statusCode}`
        : health.statusCode
          ? `健康路径返回 HTTP ${health.statusCode}`
          : "健康路径请求失败";
  return { ...endpoint, reachable, pids, ...health, probeState, probeMessage };
}
