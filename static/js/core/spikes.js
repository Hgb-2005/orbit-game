import { CONFIG } from "../config.js";
import { clamp, distanceSquared } from "./entities.js";

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
    spikes.push({ ...point, charge: 0 });
  }
  return spikes;
}

export function collidesWithSpike(cell, spike) {
  return distanceSquared(cell, spike) <= (cell.radius + spike.radius * 0.72) ** 2;
}

/** 临时刺球用指数积分移动，寿命和路程不会随帧率变化；边界处停止。 */
export function updateSpikes(spikes, dt, bounds) {
  const decay = Math.exp(-CONFIG.spikes.launchDecay * dt);
  const travel = (1 - decay) / CONFIG.spikes.launchDecay;
  for (const spike of spikes) {
    if (!spike.projectile) continue;
    const step = Math.min(dt, Math.max(0, spike.life));
    const distance = step === dt ? travel : (1 - Math.exp(-CONFIG.spikes.launchDecay * step)) / CONFIG.spikes.launchDecay;
    const x = spike.x + spike.vx * distance, y = spike.y + spike.vy * distance;
    spike.x = clamp(x, spike.radius, bounds.width - spike.radius);
    spike.y = clamp(y, spike.radius, bounds.height - spike.radius);
    spike.vx = x === spike.x ? spike.vx * decay : 0;
    spike.vy = y === spike.y ? spike.vy * decay : 0;
    spike.life -= dt;
  }
  return spikes.filter(spike => !spike.projectile || spike.life > 0);
}

/** 固定刺吃满五颗孢子后沿最后一颗的方向发射。临时刺不能再次繁殖。 */
export function feedSpikes(spikes, spores, bounds, nextId) {
  const events = [];
  const fixed = spikes.filter(spike => !spike.projectile);
  for (const spore of spores) {
    if (!spore.alive) continue;
    const spike = fixed.find(candidate => distanceSquared(candidate, spore) <= (candidate.radius * 0.72 + spore.radius) ** 2);
    if (!spike || spikes.length >= CONFIG.spikes.count + CONFIG.spikes.maxExtra) continue;
    spore.alive = false;
    spike.charge = (spike.charge || 0) + 1;
    events.push({ type: "spike-feed", actorId: spore.ownerId, x: spike.x, y: spike.y, color: spike.color });
    if (spike.charge < CONFIG.spikes.feedCount) continue;
    let dx = spore.vx, dy = spore.vy;
    if (Math.hypot(dx, dy) < 0.001) { dx = spike.x - spore.x; dy = spike.y - spore.y; }
    const length = Math.hypot(dx, dy);
    if (length < 0.001) { dx = 1; dy = 0; } else { dx /= length; dy /= length; }
    spike.charge = 0;
    const radius = CONFIG.spikes.radius;
    const launched = { id: nextId(), x: clamp(spike.x + dx * (radius * 2 + 4), radius, bounds.width - radius),
      y: clamp(spike.y + dy * (radius * 2 + 4), radius, bounds.height - radius), radius,
      vx: dx * CONFIG.spikes.launchSpeed, vy: dy * CONFIG.spikes.launchSpeed,
      projectile: true, life: CONFIG.spikes.lifetime, color: "#a5e17e" };
    spikes.push(launched);
    events.push({ type: "spike-launch", actorId: spore.ownerId, x: launched.x, y: launched.y, color: launched.color });
  }
  return events;
}
