import { CONFIG } from "../config.js";
import { clamp, distanceSquared, growBall } from "./entities.js";

/**
 * 孢子是独立的、可序列化的移动实体。
 * 规则层不依赖 Canvas，后续联机时可以直接把数组放进 WebSocket 快照。
 */
export function createSpore({ id, x, y, direction, ownerId, color }) {
  const length = Math.hypot(direction?.x ?? 0, direction?.y ?? 0) || 1;
  return {
    id, ownerId, x, y, mass: CONFIG.spore.mass,
    radius: Math.sqrt(CONFIG.spore.mass) * 2.2,
    vx: (direction?.x ?? 1) / length * CONFIG.spore.speed,
    vy: (direction?.y ?? 0) / length * CONFIG.spore.speed,
    color: color || "#9bd7bc", life: CONFIG.spore.lifetime, alive: true,
  };
}

export function updateSpores(spores, dt, bounds) {
  const decay = Math.exp(-CONFIG.spore.decay * dt);
  for (const spore of spores) {
    if (!spore.alive) continue;
    spore.life -= dt;
    spore.x += spore.vx * dt;
    spore.y += spore.vy * dt;
    spore.vx *= decay;
    spore.vy *= decay;
    if (spore.life <= 0 || spore.x < -spore.radius || spore.y < -spore.radius ||
        spore.x > bounds.width + spore.radius || spore.y > bounds.height + spore.radius) {
      spore.alive = false;
    }
  }
  return spores.filter(spore => spore.alive);
}

/** 返回本帧被吃掉的孢子，并把质量交给碰撞到它的球。 */
export function consumeSpores(spores, balls, ballGrid = null) {
  const consumed = [];
  for (const spore of spores) {
    if (!spore.alive) continue;
    const candidates = ballGrid ? ballGrid.queryCircle(spore.x, spore.y, spore.radius +
      Math.max(...balls.map(ball => ball.radius), 0)) : balls;
    const eater = candidates.find(ball => ball.alive && distanceSquared(ball, spore) <= (ball.radius + spore.radius) ** 2);
    if (!eater) continue;
    growBall(eater, spore.mass);
    spore.alive = false;
    consumed.push({ spore, eater });
  }
  return { spores: spores.filter(spore => spore.alive), consumed };
}

export function spawnPosition(ball, direction) {
  const length = Math.hypot(direction.x, direction.y) || 1;
  const dx = direction.x / length;
  const dy = direction.y / length;
  return {
    x: clamp(ball.x + dx * (ball.radius + 8), ball.radius, Infinity),
    y: clamp(ball.y + dy * (ball.radius + 8), ball.radius, Infinity),
  };
}
