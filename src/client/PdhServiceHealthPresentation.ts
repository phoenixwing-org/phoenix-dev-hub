import type {
  EndpointStatus,
  ServiceHealthState,
  ServiceRuntimeStatus,
} from "@shared/contracts";

export type PdhPresentedHealthState = ServiceHealthState | "checking";
export type PdhPresentedEndpointState = EndpointStatus["probeState"] | "checking";

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
export function pdhHealthIsChecking(service: ServiceRuntimeStatus): boolean {
  return service.lifecycle === "starting"
    && service.build.state !== "failed"
    && service.health !== "ready"
    && service.health !== "reachable";
}

export function pdhPresentedHealth(service: ServiceRuntimeStatus): {
  readonly state: PdhPresentedHealthState;
  readonly label: string;
} {
  return pdhHealthIsChecking(service)
    ? { state: "checking", label: "正在检查" }
    : { state: service.health, label: healthLabels[service.health] };
}

export function pdhPresentedEndpoint(
  service: ServiceRuntimeStatus,
  endpoint: EndpointStatus,
): {
  readonly state: PdhPresentedEndpointState;
  readonly label: string;
} {
  if (pdhHealthIsChecking(service) && endpoint.probeState !== "healthy") {
    return { state: "checking", label: "CHECKING" };
  }
  return { state: endpoint.probeState, label: endpointLabels[endpoint.probeState] };
}
