import { nextTick } from "vue";
import { createPinia, setActivePinia } from "pinia";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePnhWorkbenchPreferencesStore } from "./PnhWorkbenchPreferencesStore";

const values = new Map<string, string>();
const storage: Storage = {
  get length() {
    return values.size;
  },
  clear: () => values.clear(),
  getItem: (key) => values.get(key) ?? null,
  key: (index) => [...values.keys()][index] ?? null,
  removeItem: (key) => void values.delete(key),
  setItem: (key, value) => void values.set(key, value),
};

beforeEach(() => {
  values.clear();
  vi.stubGlobal("localStorage", storage);
  setActivePinia(createPinia());
});

afterEach(() => vi.unstubAllGlobals());

describe("PnhWorkbenchPreferencesStore", () => {
  it("首次使用跟随系统", () => {
    const store = usePnhWorkbenchPreferencesStore();
    expect(store.colorScheme).toBe("system");
    expect(store.layoutState.visibility.secondary).toBe(false);
    expect(store.serviceSearchQuery).toBe("");
    expect(store.serviceSortMode).toBe("name");
    expect(store.collapsedServiceSeriesIds).toEqual([]);
    expect(store.collapsedServiceProfileIds).toEqual([]);
  });

  it("恢复用户主题并在修改后持久化", async () => {
    storage.setItem("phoenix-hub.workbench.v1", JSON.stringify({ colorScheme: "light" }));
    const store = usePnhWorkbenchPreferencesStore();
    expect(store.colorScheme).toBe("light");

    store.colorScheme = "dark";
    await nextTick();
    expect(JSON.parse(storage.getItem("phoenix-hub.workbench.v1") ?? "{}")).toMatchObject({
      colorScheme: "dark",
    });
  });

  it("恢复并持久化服务搜索与排序偏好", async () => {
    storage.setItem("phoenix-hub.workbench.v1", JSON.stringify({
      serviceSearchQuery: "8101",
      serviceSortMode: "port",
      collapsedServiceSeriesIds: ["phoenix-admin"],
      collapsedServiceProfileIds: ["phoenix-admin/stable"],
    }));
    const store = usePnhWorkbenchPreferencesStore();
    expect(store.serviceSearchQuery).toBe("8101");
    expect(store.serviceSortMode).toBe("port");
    expect(store.collapsedServiceSeriesIds).toEqual(["phoenix-admin"]);
    expect(store.collapsedServiceProfileIds).toEqual(["phoenix-admin/stable"]);

    store.serviceSearchQuery = "admin";
    store.serviceSortMode = "status";
    store.collapsedServiceSeriesIds = ["open-issue"];
    await nextTick();
    expect(JSON.parse(storage.getItem("phoenix-hub.workbench.v1") ?? "{}")).toMatchObject({
      serviceSearchQuery: "admin",
      serviceSortMode: "status",
      collapsedServiceSeriesIds: ["open-issue"],
    });
  });
});
