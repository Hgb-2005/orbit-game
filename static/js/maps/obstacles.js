import { resolveBallBounds, speedForMass } from "../core/entities.js";

/**
 * 静态圆形障碍与球体做最短向量推出。障碍永远不能被吞噬，球群、分身、
 * AI 和孢子都走同一个函数。
 */
export function resolveObstacleCollisions(entity, obstacles = [], bounds = null) {
  if (!entity || !Array.isArray(obstacles)) return entity;
  for (let pass = 0; pass < 3; pass++) {
    let adjusted = false;
    for (const obstacle of obstacles) {
      let dx = entity.x - obstacle.x;
      let dy = entity.y - obstacle.y;
      let distance = Math.hypot(dx, dy);
      const minimum = entity.radius + obstacle.radius;
      if (distance >= minimum) continue;
      if (distance < 1e-6) {
        dx = 1;
        dy = 0;
        distance = 1;
      }
      const nx = dx / distance;
      const ny = dy / distance;
      entity.x = obstacle.x + nx * minimum;
      entity.y = obstacle.y + ny * minimum;
      const inward = (entity.vx ?? 0) * nx + (entity.vy ?? 0) * ny;
      if (inward < 0) {
        entity.vx = (entity.vx ?? 0) - inward * nx * 1.12;
        entity.vy = (entity.vy ?? 0) - inward * ny * 1.12;
        if ("impulseX" in entity) {
          const impulseIn = entity.impulseX * nx + entity.impulseY * ny;
          if (impulseIn < 0) {
            entity.impulseX -= impulseIn * nx * 1.08;
            entity.impulseY -= impulseIn * ny * 1.08;
          }
        }
      }
      adjusted = true;
    }
    if (!adjusted) break;
  }
  if (bounds) resolveBallBounds(entity, bounds);
  if (entity.mass != null && entity.speed != null) entity.speed = speedForMass(entity.mass);
  return entity;
}

export function resolveSporeObstacleCollisions(spore, obstacles = [], bounds = null) {
  for (const obstacle of obstacles) {
    const dx = spore.x - obstacle.x;
    const dy = spore.y - obstacle.y;
    const distance = Math.hypot(dx, dy) || 1;
    const minimum = spore.radius + obstacle.radius;
    if (distance >= minimum) continue;
    const nx = dx / distance;
    const ny = dy / distance;
    spore.x = obstacle.x + nx * minimum;
    spore.y = obstacle.y + ny * minimum;
    const inward = spore.vx * nx + spore.vy * ny;
    if (inward < 0) {
      spore.vx -= inward * nx * 1.8;
      spore.vy -= inward * ny * 1.8;
    }
  }
  if (bounds) {
    spore.x = Math.max(spore.radius, Math.min(bounds.width - spore.radius, spore.x));
    spore.y = Math.max(spore.radius, Math.min(bounds.height - spore.radius, spore.y));
  }
  return spore;
}
