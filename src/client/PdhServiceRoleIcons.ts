import {
  defineComponent,
  h,
  type Component,
} from "vue";
import type {
  ServiceDefinition,
  ServiceRuntimeStatus,
} from "@shared/contracts";

const svgAttributes = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: "1.8",
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": "true",
};

type PdhServiceRole = "web" | "api" | "app";
type PdhServiceState = Pick<ServiceRuntimeStatus, "health" | "lifecycle">;

function rolePaths(role: PdhServiceRole): ReturnType<typeof h>[] {
  if (role === "web") {
    return [
      h("circle", { cx: "12", cy: "12", r: "8.5" }),
      h("path", { d: "M3.5 12h17" }),
      h("path", { d: "M12 3.5c2.4 2.3 3.7 5.1 3.7 8.5S14.4 18.2 12 20.5c-2.4-2.3-3.7-5.1-3.7-8.5S9.6 5.8 12 3.5Z" }),
    ];
  }
  if (role === "api") {
    return [
      h("rect", { x: "3.5", y: "4.5", width: "17", height: "15", rx: "2.5" }),
      h("path", { d: "M7.5 9h.01M7.5 15h.01M11 9h5.5M11 15h5.5" }),
    ];
  }
  return [
    h("rect", { x: "3.5", y: "4", width: "17", height: "16", rx: "2.5" }),
    h("path", { d: "M3.5 9h17M7 6.5h.01M10 6.5h.01M8 13h3M14 13h2.5M8 16.5h3M14 16.5h2.5" }),
  ];
}

function stateMarker(state: PdhServiceState): ReturnType<typeof h> {
  if (state.health === "ready") {
    return h("circle", { cx: "18", cy: "18", r: "3", fill: "currentColor", stroke: "none" });
  }
  if (state.lifecycle === "external") {
    return h("path", { d: "m18 14.8 3.2 3.2-3.2 3.2-3.2-3.2Z", fill: "currentColor", stroke: "none" });
  }
  return h("circle", { cx: "18", cy: "18", r: "2.7", fill: "none" });
}

function serviceIcon(role: PdhServiceRole, state: PdhServiceState): Component {
  return defineComponent({
    name: ({
      api: "PdhApiServiceIcon",
      app: "PdhApplicationServiceIcon",
      web: "PdhWebServiceIcon",
    })[role],
    setup: () => () => h("svg", svgAttributes, [...rolePaths(role), stateMarker(state)]),
  });
}

/** Ribbon 主体按服务角色区分；右下状态标记沿用实心/空心/菱形的既有语义。 */
export function pdhServiceRibbonIcon(
  service: Pick<ServiceRuntimeStatus, "health" | "lifecycle"> & {
    readonly definition: Pick<ServiceDefinition, "serviceRole">;
  },
): Component {
  const role: PdhServiceRole = service.definition.serviceRole === "api"
    ? "api"
    : service.definition.serviceRole === "web"
      ? "web"
      : "app";
  return serviceIcon(role, service);
}
