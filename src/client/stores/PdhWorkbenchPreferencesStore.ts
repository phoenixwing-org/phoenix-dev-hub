import { ref, watch } from "vue";
import { defineStore } from "pinia";
import {
  PNW_DEFAULT_WORKBENCH_DISPLAY_PREFERENCES,
  pnwNormalizeWorkbenchDisplayPreferences,
  type PnwWorkbenchDisplayPreferences,
  type PnwWorkbenchLayoutState,
} from "phoenix-wing";

const PREFERENCES_KEY = "phoenix-dev-hub.workbench.v1";
export type PdhServiceSortMode = "configured" | "name" | "status" | "port";

interface PdhStoredPreferences extends Partial<PnwWorkbenchDisplayPreferences> {
  readonly serviceSearchQuery?: string;
  readonly serviceSortMode?: PdhServiceSortMode;
  readonly collapsedServiceSeriesIds?: readonly string[];
  readonly collapsedServiceProfileIds?: readonly string[];
}

function isServiceSortMode(value: unknown): value is PdhServiceSortMode {
  return value === "configured" || value === "name" || value === "status" || value === "port";
}

function loadPreferences(): {
  readonly display: PnwWorkbenchDisplayPreferences;
  readonly serviceSearchQuery: string;
  readonly serviceSortMode: PdhServiceSortMode;
  readonly collapsedServiceSeriesIds: readonly string[];
  readonly collapsedServiceProfileIds: readonly string[];
} {
  try {
    const stored = localStorage.getItem(PREFERENCES_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as PdhStoredPreferences;
      return {
        display: pnwNormalizeWorkbenchDisplayPreferences(parsed),
        serviceSearchQuery: typeof parsed.serviceSearchQuery === "string" ? parsed.serviceSearchQuery : "",
        serviceSortMode: isServiceSortMode(parsed.serviceSortMode) ? parsed.serviceSortMode : "name",
        collapsedServiceSeriesIds: Array.isArray(parsed.collapsedServiceSeriesIds)
          ? parsed.collapsedServiceSeriesIds.filter((item): item is string => typeof item === "string")
          : [],
        collapsedServiceProfileIds: Array.isArray(parsed.collapsedServiceProfileIds)
          ? parsed.collapsedServiceProfileIds.filter((item): item is string => typeof item === "string")
          : [],
      };
    }
  } catch {
    localStorage.removeItem(PREFERENCES_KEY);
  }

  return {
    display: pnwNormalizeWorkbenchDisplayPreferences({
      ...PNW_DEFAULT_WORKBENCH_DISPLAY_PREFERENCES,
      colorScheme: "system",
      layoutState: {
        ...PNW_DEFAULT_WORKBENCH_DISPLAY_PREFERENCES.layoutState,
        visibility: { primary: true, bottom: true, secondary: false },
      },
    }),
    serviceSearchQuery: "",
    serviceSortMode: "name",
    collapsedServiceSeriesIds: [],
    collapsedServiceProfileIds: [],
  };
}

/** 持有并持久化 Dev Hub 工作台显示偏好；首次使用跟随系统。 */
export const usePdhWorkbenchPreferencesStore = defineStore(
  "pdhWorkbenchPreferences",
  () => {
    const saved = loadPreferences();
    const presentation = ref(saved.display.presentation);
    const ribbonAppearance = ref({
      ...saved.display.ribbonAppearance,
      compact: { ...saved.display.ribbonAppearance.compact },
      ribbon: { ...saved.display.ribbonAppearance.ribbon },
    });
    const treeCollapsed = ref(saved.display.treeCollapsed);
    const treeAppearance = ref({ ...saved.display.treeAppearance });
    const tabBarPlacement = ref(saved.display.tabBarPlacement);
    const colorScheme = ref(saved.display.colorScheme);
    const layoutState = ref<PnwWorkbenchLayoutState>({
      visibility: { ...saved.display.layoutState.visibility },
      sizes: { ...saved.display.layoutState.sizes },
    });
    const displaySettingsPositions = ref({
      quick: { ...saved.display.settingsPositions.quick },
      full: { ...saved.display.settingsPositions.full },
    });
    const serviceSearchQuery = ref(saved.serviceSearchQuery);
    const serviceSortMode = ref<PdhServiceSortMode>(saved.serviceSortMode);
    const collapsedServiceSeriesIds = ref<readonly string[]>(saved.collapsedServiceSeriesIds);
    const collapsedServiceProfileIds = ref<readonly string[]>(saved.collapsedServiceProfileIds);

    watch(
      [
        presentation,
        ribbonAppearance,
        treeCollapsed,
        treeAppearance,
        tabBarPlacement,
        colorScheme,
        layoutState,
        displaySettingsPositions,
        serviceSearchQuery,
        serviceSortMode,
        collapsedServiceSeriesIds,
        collapsedServiceProfileIds,
      ],
      () => {
        localStorage.setItem(PREFERENCES_KEY, JSON.stringify({
          presentation: presentation.value,
          ribbonAppearance: ribbonAppearance.value,
          treeCollapsed: treeCollapsed.value,
          treeAppearance: treeAppearance.value,
          tabBarPlacement: tabBarPlacement.value,
          colorScheme: colorScheme.value,
          layoutState: layoutState.value,
          settingsPositions: displaySettingsPositions.value,
          serviceSearchQuery: serviceSearchQuery.value,
          serviceSortMode: serviceSortMode.value,
          collapsedServiceSeriesIds: collapsedServiceSeriesIds.value,
          collapsedServiceProfileIds: collapsedServiceProfileIds.value,
        }));
      },
      { deep: true },
    );

    return {
      presentation,
      ribbonAppearance,
      treeCollapsed,
      treeAppearance,
      tabBarPlacement,
      colorScheme,
      layoutState,
      displaySettingsPositions,
      serviceSearchQuery,
      serviceSortMode,
      collapsedServiceSeriesIds,
      collapsedServiceProfileIds,
    };
  },
);
