/**
 * 地图文件的唯一浏览器端契约。编辑器、单机、联机准备室和测试都使用
 * 这里的结果，服务端还会用 Python 版本再次校验，不能信任分享链接。
 */
export const MAP_VERSION = 1;
export const MAP_LIMITS = Object.freeze({
  minWidth: 1600,
  maxWidth: 4800,
  minHeight: 1200,
  maxHeight: 3600,
  maxSpikes: 32,
  maxObstacles: 48,
  maxSpawnPoints: 4,
});

export const DEFAULT_MAP = Object.freeze({
  version: MAP_VERSION,
  id: "default",
  name: "微光标准场",
  width: 3200,
  height: 2200,
  spawnPoints: [
    { x: 800, y: 550 },
    { x: 2400, y: 1650 },
    { x: 2400, y: 550 },
    { x: 800, y: 1650 },
  ],
  spikes: [],
  obstacles: [],
});

const finite = value => typeof value === "number" && Number.isFinite(value);
const ID_PATTERN = /^[a-z0-9_-]{1,48}$/;
const COLOR_PATTERN = /^#[0-9a-f]{6}$/i;

function fail(message) {
  throw new Error(message);
}

function boundedNumber(value, label, min, max, strict) {
  if (!finite(value) || value < min || value > max) {
    if (strict) fail(`${label}必须是 ${min}～${max} 之间的数字。`);
    return null;
  }
  return Math.round(value * 1000) / 1000;
}

function requiredText(value, label, max, strict) {
  if (typeof value !== "string") {
    if (strict) fail(`${label}必须是文本。`);
    return "";
  }
  const cleaned = value.trim().replace(/[\u0000-\u001f]/g, "").slice(0, max);
  if (!cleaned && strict) fail(`${label}不能为空。`);
  return cleaned;
}

function identifier(value, label, strict) {
  const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!ID_PATTERN.test(normalized)) {
    if (strict) fail(`${label}只能包含小写字母、数字、短横线和下划线。`);
    return "";
  }
  return normalized;
}

function mapPoint(value, width, height, margin, label, strict) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    if (strict) fail(`${label}必须是坐标对象。`);
    return null;
  }
  const x = boundedNumber(value.x, `${label} X`, margin, width - margin, strict);
  const y = boundedNumber(value.y, `${label} Y`, margin, height - margin, strict);
  return x === null || y === null ? null : { x, y };
}

function defaultSpawn(index, width, height) {
  return {
    id: `spawn-${index + 1}`,
    x: width * (index % 2 ? .75 : .25),
    y: height * (index >= 2 ? .75 : .25),
  };
}

/**
 * 返回全新的规范化副本。strict=true 用于编辑器保存、导入和联机传入；
 * 此时任何会造成不同客户端地图不一致的字段都会直接拒绝，不做静默修正。
 */
export function normalizeMap(input, { strict = false } = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    if (strict) fail("地图必须是 JSON 对象。");
    return structuredClone(DEFAULT_MAP);
  }
  if (strict && input.version !== MAP_VERSION) {
    fail(`不支持的地图版本，需要版本 ${MAP_VERSION}。`);
  }
  let width;
  let height;
  try {
    width = boundedNumber(input.width, "地图宽度", MAP_LIMITS.minWidth, MAP_LIMITS.maxWidth, strict);
    height = boundedNumber(input.height, "地图高度", MAP_LIMITS.minHeight, MAP_LIMITS.maxHeight, strict);
    if (!Number.isInteger(input.width) || !Number.isInteger(input.height)) fail("地图尺寸必须是整数。");
  } catch (error) {
    if (strict) throw error;
    return structuredClone(DEFAULT_MAP);
  }
  if (width === null || height === null) return structuredClone(DEFAULT_MAP);

  const readList = (key, limit, label) => {
    const value = input[key];
    if (!Array.isArray(value) || value.length > limit || (strict && key === "spawnPoints" && value.length < 1)) {
      if (strict) fail(`${label}必须${key === "spawnPoints" ? "包含至少 1 个且" : ""}不超过 ${limit} 个。`);
      return [];
    }
    return value;
  };

  let spawnRaw;
  let spikeRaw;
  let obstacleRaw;
  let id;
  let name;
  try {
    id = identifier(input.id, "地图 ID", strict);
    name = requiredText(input.name, "地图名称", 28, strict);
    if (strict && !id) fail("地图 ID 无效。");
    if (strict && !name) fail("地图名称不能为空。");
    spawnRaw = readList("spawnPoints", MAP_LIMITS.maxSpawnPoints, "出生点");
    spikeRaw = readList("spikes", MAP_LIMITS.maxSpikes, "刺球");
    obstacleRaw = readList("obstacles", MAP_LIMITS.maxObstacles, "障碍物");
  } catch (error) {
    if (strict) throw error;
    return structuredClone(DEFAULT_MAP);
  }

  const spawns = [];
  for (const [index, value] of spawnRaw.entries()) {
    const point = mapPoint(value, width, height, 80, `出生点 ${index + 1}`, strict);
    const spawnId = identifier(value?.id, "出生点 ID", strict);
    if (!point || (strict && !spawnId)) {
      if (strict) fail(`出生点 ${index + 1} 数据无效。`);
      continue;
    }
    spawns.push({ id: spawnId || `spawn-${index + 1}`, ...point });
  }
  while (spawns.length < MAP_LIMITS.maxSpawnPoints) spawns.push(defaultSpawn(spawns.length, width, height));

  const spikes = [];
  for (const [index, value] of spikeRaw.entries()) {
    const point = mapPoint(value, width, height, 24, `刺球 ${index + 1}`, strict);
    const spikeId = identifier(value?.id, "刺球 ID", strict);
    const radius = boundedNumber(value?.radius, "刺球半径", 24, 110, strict);
    const color = typeof value?.color === "string" && COLOR_PATTERN.test(value.color) ? value.color : "#72c98e";
    if (strict && !COLOR_PATTERN.test(String(value?.color ?? ""))) fail(`刺球 ${index + 1} 颜色必须使用 #RRGGBB。`);
    if (!point || !spikeId || radius === null) {
      if (strict) fail(`刺球 ${index + 1} 数据无效。`);
      continue;
    }
    spikes.push({ id: spikeId, ...point, radius, color });
  }

  const obstacles = [];
  for (const [index, value] of obstacleRaw.entries()) {
    const point = mapPoint(value, width, height, 20, `障碍物 ${index + 1}`, strict);
    const obstacleId = identifier(value?.id, "障碍物 ID", strict);
    const radius = boundedNumber(value?.radius, "障碍物半径", 30, 360, strict);
    const color = typeof value?.color === "string" && COLOR_PATTERN.test(value.color) ? value.color : "#60716b";
    if (strict && !COLOR_PATTERN.test(String(value?.color ?? ""))) fail(`障碍物 ${index + 1} 颜色必须使用 #RRGGBB。`);
    if (!point || !obstacleId || radius === null) {
      if (strict) fail(`障碍物 ${index + 1} 数据无效。`);
      continue;
    }
    const obstacle = { id: obstacleId, ...point, radius, color };
    if (strict) {
      const spawnConflict = spawns.some(spawn =>
        Math.hypot(obstacle.x - spawn.x, obstacle.y - spawn.y) < obstacle.radius + 72);
      if (spawnConflict) fail(`${obstacleId} 覆盖了出生安全区。`);
      const overlap = obstacles.some(other =>
        Math.hypot(obstacle.x - other.x, obstacle.y - other.y) < obstacle.radius + other.radius);
      if (overlap) fail("障碍物之间不能重叠。");
    }
    obstacles.push(obstacle);
  }

  const ids = [...spawns, ...spikes, ...obstacles].map(item => item.id);
  if (new Set(ids).size !== ids.length) {
    if (strict) fail("地图物件 ID 不能重复。");
    return structuredClone(DEFAULT_MAP);
  }
  return {
    version: MAP_VERSION,
    id: id || "custom-map",
    name: name || "未命名球场",
    width,
    height,
    spawnPoints: spawns,
    spikes,
    obstacles,
  };
}

export function cloneMap(map) {
  return normalizeMap(map);
}

export function createBlankMap(name = "新球场") {
  return normalizeMap({ ...DEFAULT_MAP, id: `map-${Date.now().toString(36)}`, name });
}

export function encodeMap(map) {
  const value = normalizeMap(map);
  return encodeURIComponent(JSON.stringify(value));
}

export function decodeMap(value) {
  if (!value) return null;
  try {
    return normalizeMap(JSON.parse(decodeURIComponent(value)), { strict: true });
  } catch {
    return null;
  }
}

export function mapFromLocation(search = globalThis.location?.search ?? "") {
  return decodeMap(new URLSearchParams(search).get("map"));
}

export function obstacleContains(pointValue, obstacle, padding = 0) {
  const dx = pointValue.x - obstacle.x;
  const dy = pointValue.y - obstacle.y;
  return dx * dx + dy * dy < (obstacle.radius + padding) ** 2;
}

export function mapIsClear(pointValue, map, radius = 0, { obstacles = true, spikes = false } = {}) {
  if (obstacles && map.obstacles.some(item => obstacleContains(pointValue, item, radius))) return false;
  if (spikes && map.spikes.some(item => obstacleContains(pointValue, item, radius))) return false;
  return true;
}
