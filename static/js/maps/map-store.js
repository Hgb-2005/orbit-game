import { cloneMap, DEFAULT_MAP, normalizeMap } from "./map-schema.js";

const MAPS_KEY = "orbit.maps.v1";
const ACTIVE_KEY = "orbit.active-map.v1";
const PRESETS_KEY = "orbit.match-presets.v1";

function read(key, fallback) {
  try {
    const parsed = JSON.parse(localStorage.getItem(key) || "null");
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function write(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export class MapStore {
  list() {
    const values = read(MAPS_KEY, []);
    const maps = (Array.isArray(values) ? values : []).flatMap(value => {
      try { return [normalizeMap(value)]; } catch { return []; }
    });
    if (!maps.some(map => map.id === DEFAULT_MAP.id)) maps.unshift(cloneMap(DEFAULT_MAP));
    return maps;
  }

  active() {
    const id = read(ACTIVE_KEY, DEFAULT_MAP.id);
    return this.list().find(map => map.id === id) ?? cloneMap(DEFAULT_MAP);
  }

  setActive(mapOrId) {
    const map = typeof mapOrId === "string" ? this.list().find(item => item.id === mapOrId) : normalizeMap(mapOrId);
    if (!map) throw new Error("找不到这张地图。");
    write(ACTIVE_KEY, map.id);
    return map;
  }

  save(input) {
    const map = normalizeMap(input, { strict: true });
    const maps = this.list();
    const index = maps.findIndex(item => item.id === map.id);
    if (index >= 0) maps[index] = map;
    else maps.push(map);
    write(MAPS_KEY, maps);
    return map;
  }

  remove(id) {
    if (id === DEFAULT_MAP.id) throw new Error("标准场不能删除。");
    const wasActive = this.active().id === id;
    write(MAPS_KEY, this.list().filter(map => map.id !== id));
    if (wasActive) write(ACTIVE_KEY, DEFAULT_MAP.id);
  }

  importJson(value) {
    const parsed = typeof value === "string" ? JSON.parse(value) : value;
    return this.save(parsed);
  }

  exportJson(map) {
    return JSON.stringify(normalizeMap(map), null, 2);
  }

  presets() {
    const values = read(PRESETS_KEY, []);
    return Array.isArray(values) ? values.filter(item => item && typeof item.name === "string" && item.map) : [];
  }

  savePreset(name, map, rules = {}) {
    const clean = String(name || "").trim().slice(0, 28);
    if (!clean) throw new Error("请输入预设名称。");
    const presets = this.presets().filter(item => item.name !== clean);
    const value = { name: clean, map: normalizeMap(map), rules: { ...rules }, savedAt: Date.now() };
    presets.unshift(value);
    write(PRESETS_KEY, presets.slice(0, 20));
    return value;
  }

  findPreset(name) {
    return this.presets().find(item => item.name === name) ?? null;
  }

  removePreset(name) {
    write(PRESETS_KEY, this.presets().filter(item => item.name !== name));
  }
}

export const mapStore = new MapStore();
