import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MAP,
  cloneMap,
  decodeMap,
  encodeMap,
  mapIsClear,
  normalizeMap,
  obstacleContains,
} from "../static/js/maps/map-schema.js";
import { MapStore } from "../static/js/maps/map-store.js";

function mockStorage(t) {
  const original = globalThis.localStorage;
  const values = new Map();
  globalThis.localStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: key => values.delete(key),
  };
  t.after(() => {
    if (original === undefined) delete globalThis.localStorage;
    else globalThis.localStorage = original;
  });
  return values;
}

function customMap(overrides = {}) {
  return {
    ...cloneMap(DEFAULT_MAP),
    id: "duel-yard",
    name: "决斗庭院",
    width: 2400,
    height: 1800,
    spawnPoints: [
      { id: "spawn-a", x: 320, y: 300 },
      { id: "spawn-b", x: 2080, y: 1500 },
    ],
    spikes: [
      { id: "spike-a", x: 1200, y: 500, radius: 48, color: "#72c98e" },
    ],
    obstacles: [
      { id: "block-a", x: 1200, y: 900, radius: 120, color: "#60716b" },
    ],
    ...overrides,
  };
}

test("地图规范化和分享链接保留完整协议且输入对象不会被修改", () => {
  const input = customMap();
  const before = structuredClone(input);
  const normalized = normalizeMap(input, { strict: true });
  assert.deepEqual(input, before);
  assert.equal(normalized.id, "duel-yard");
  assert.equal(normalized.obstacles[0].radius, 120);
  const decoded = decodeMap(encodeMap(normalized));
  assert.deepEqual(decoded, normalized);
  assert.equal(decodeMap("%broken"), null);
});

test("严格校验拒绝非整数尺寸、错误颜色、重复 ID 和危险障碍布局", () => {
  assert.throws(() => normalizeMap(customMap({ width: 2400.5 }), { strict: true }), /整数/);
  assert.throws(() => normalizeMap(customMap({
    spikes: [{ id: "spike-a", x: 1200, y: 500, radius: 48, color: "green" }],
  }), { strict: true }), /#RRGGBB/);
  assert.throws(() => normalizeMap(customMap({
    spikes: [{ id: "same", x: 600, y: 300, radius: 48, color: "#72c98e" }],
    obstacles: [{ id: "same", x: 1200, y: 900, radius: 120, color: "#60716b" }],
  }), { strict: true }), /不能重复/);
  assert.throws(() => normalizeMap(customMap({
    obstacles: [{ id: "spawn-block", x: 320, y: 300, radius: 120, color: "#60716b" }],
  }), { strict: true }), /出生安全区/);
  assert.throws(() => normalizeMap(customMap({
    obstacles: [
      { id: "block-a", x: 1200, y: 900, radius: 120, color: "#60716b" },
      { id: "block-b", x: 1300, y: 900, radius: 120, color: "#60716b" },
    ],
  }), { strict: true }), /不能重叠/);
});

test("障碍查询同时考虑球体半径，清空检测可单独忽略刺球", () => {
  const map = customMap();
  const obstacle = map.obstacles[0];
  assert.equal(obstacleContains({ x: 1250, y: 900 }, obstacle), true);
  assert.equal(obstacleContains({ x: 1250, y: 900 }, obstacle, 50), true);
  assert.equal(mapIsClear({ x: 1250, y: 900 }, map, 50), false);
  assert.equal(mapIsClear({ x: map.spikes[0].x, y: map.spikes[0].y }, map, 0), true);
  assert.equal(mapIsClear({ x: map.spikes[0].x, y: map.spikes[0].y }, map, 0, {
    obstacles: true,
    spikes: true,
  }), false);
});

test("地图仓库持久化当前地图、导入导出、预设删除与活动地图回退", t => {
  mockStorage(t);
  const store = new MapStore();
  assert.equal(store.list()[0].id, "default");
  assert.equal(store.active().id, "default");

  const saved = store.save(customMap());
  store.setActive(saved);
  assert.equal(store.active().id, "duel-yard");
  assert.deepEqual(JSON.parse(store.exportJson(saved)).name, "决斗庭院");
  assert.equal(store.importJson(store.exportJson({
    ...saved,
    id: "imported-map",
    name: "导入球场",
  })).name, "导入球场");

  const preset = store.savePreset("团队回廊", saved, {
    mode: "survival",
    duration: 300,
    botCount: 2,
  });
  assert.equal(preset.rules.botCount, 2);
  assert.equal(store.findPreset("团队回廊").map.id, "duel-yard");

  store.remove("duel-yard");
  assert.equal(store.active().id, "default");
  assert.equal(store.list().some(map => map.id === "duel-yard"), false);
  assert.throws(() => store.remove("default"), /标准场不能删除/);

  store.removePreset("团队回廊");
  assert.equal(store.findPreset("团队回廊"), null);
});
