import { CONFIG } from "../config.js";
import { distanceSquared } from "./entities.js";

/** 生成固定在地图上的绿色刺球，出生时尽量避开玩家中心和彼此。 */
export function createSpikes(bounds, random, avoid = []) {
  const spikes = [];
  // 开局中心留出一段安全航道，避免新手刚开始移动就被随机刺球截住。
  const center = { x: bounds.width / 2, y: bounds.height / 2, radius: 620 };
  const protectedEntities = [...avoid, center];
  for (let index = 0; index < CONFIG.spikes.count; index++) {
    let point = null;
    for (let attempt = 0; attempt < 100 && !point; attempt++) {
      const candidate = {
        id: `spike-${index}`,
        x: CONFIG.spikes.radius + random() * (bounds.width - CONFIG.spikes.radius * 2),
        y: CONFIG.spikes.radius + random() * (bounds.height - CONFIG.spikes.radius * 2),
        radius: CONFIG.spikes.radius,
        color: "#72c98e",
      };
      if (protectedEntities.some(entity => distanceSquared(candidate, entity) < (candidate.radius + (entity.radius || 0) + 220) ** 2)) continue;
      if (spikes.some(other => distanceSquared(candidate, other) < (candidate.radius + other.radius + 180) ** 2)) continue;
      point = candidate;
    }
    if (!point) {
      const fallback = [
        [300, 280], [1600, 220], [2900, 280], [260, 1900], [1600, 1980],
        [2940, 1900], [520, 1100], [2680, 1100], [900, 520], [2300, 1680],
      ][index];
      point = { id: `spike-${index}`, x: fallback[0], y: fallback[1], radius: CONFIG.spikes.radius, color: "#72c98e" };
    }
    spikes.push(point);
  }
  return spikes;
}

export function collidesWithSpike(cell, spike) {
  return distanceSquared(cell, spike) <= (cell.radius + spike.radius * 0.72) ** 2;
}
