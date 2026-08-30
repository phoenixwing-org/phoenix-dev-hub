import type {
  EndpointStatus,
  ServiceHealthState,
  ServiceRuntimeStatus,
} from "@shared/contracts";

export type PnhPresentedHealthState = ServiceHealthState | "checking";
export type PnhPresentedEndpointState = EndpointStatus["probeState"] | "checking";

const healthLabels: Readonly<Record<ServiceHealthState, string>> = {
  ready: "健康就绪",
  reachable: "仅端口可达",
  partial: "部分端点未就绪",
  unhealthy: "健康检查失败",
  unknown: "尚未探测",
};

const endpointLabels: Readonly<Record<EndpointStatus["probeState"], string>> = {
  healthy: "HEALTHY",
  unhealthy: "HEALTH FAIL",
  "reachable-unverified": "LISTEN ONLY",
  unreachable: "OFF",
};

/** 启动宽限期内的暂时不可达不是故障；明确构建失败仍须立即暴露。 */
export function pnhHealthIsChecking(service: ServiceRuntimeStatus): boolean {
  return service.lifecycle === "starting"
    && service.build.state !== "failed"
    && service.health !== "ready"
    && service.health !== "reachable";
}

export function pnhPresentedHealth(service: ServiceRuntimeStatus): {
  readonly state: PnhPresentedHealthState;
  readonly label: string;
} {
  return pnhHealthIsChecking(service)
    ? { state: "checking", label: "正在检查" }
    : { state: service.health, label: healthLabels[service.health] };
}

export function pnhPresentedEndpoint(
  service: ServiceRuntimeStatus,
  endpoint: EndpointStatus,
): {
  readonly state: PnhPresentedEndpointState;
  readonly label: string;
} {
  if (pnhHealthIsChecking(service) && endpoint.probeState !== "healthy") {
    return { state: "checking", label: "CHECKING" };
  }
  return { state: endpoint.probeState, label: endpointLabels[endpoint.probeState] };
}
