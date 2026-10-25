import { CONFIG } from "../config.js";
import { distanceSquared } from "./entities.js";
import { BOT_ROLES } from "./progression.js";

/** 决策只返回方向，AI 不直接修改位置；未来可完整迁移到服务器。 */
export function chooseBotDirection(bot, world) {
  const others = [...world.playerCells, ...world.bots];
  let threat = null;
  let prey = null;
  let threatDistance = Infinity;
  let preyDistance = Infinity;
  const role = BOT_ROLES[bot.role] ?? BOT_ROLES.rival;

  for (const other of others) {
    if (other.ownerId === bot.ownerId || !other.alive) continue;
    if (world.isProtected?.(other) || (other.isPlayer && world.protectionRemaining > 0)) continue;
    const distance = distanceSquared(bot, other);
    if (other.mass >= bot.mass * CONFIG.rules.eatMassRatio &&
        distance < (other.radius + bot.radius + 190) ** 2 && distance < threatDistance) {
      threat = other;
      threatDistance = distance;
    }
    if (bot.mass >= other.mass * CONFIG.rules.eatMassRatio &&
        distance < (role.chaseRange + bot.radius) ** 2 && distance < preyDistance) {
      prey = other;
      preyDistance = distance;
    }
  }

  let dx;
  let dy;
  if (threat) {
    dx = bot.x - threat.x;
    dy = bot.y - threat.y;
  } else if (prey) {
    dx = prey.x - bot.x;
    dy = prey.y - bot.y;
  } else {
    let closest = null;
    let closestDistance = Infinity;
    for (const food of world.foods) {
      const distance = distanceSquared(bot, food);
      if (distance < closestDistance) {
        closest = food;
        closestDistance = distance;
      }
    }
    if (!closest) return { x: 0, y: 0 };
    dx = closest.x - bot.x;
    dy = closest.y - bot.y;
  }

  // 靠近边界时施加回到场内的力，防止逃跑的 AI 长时间贴墙不动。
  const edge = bot.radius + 65;
  if (bot.x < edge) dx += 140;
  if (bot.x > world.bounds.width - edge) dx -= 140;
  if (bot.y < edge) dy += 140;
  if (bot.y > world.bounds.height - edge) dy -= 140;
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

/** 追猎者只在分裂后仍能吃掉目标、且附近没有强敌时尝试弹射。 */
export function chooseBotSplit(bot, world) {
  if (world.isProtected?.(bot)) return null;
  if (bot.role !== "hunter" || bot.mass < CONFIG.split.minimumMass) return null;
  const others = [...world.playerCells, ...world.bots].filter(other =>
    other.alive && other.ownerId !== bot.ownerId && !world.isProtected?.(other) && !(other.isPlayer && world.protectionRemaining > 0));
  if (others.some(other => distanceSquared(bot, other) < (bot.radius + other.radius + 180) ** 2 &&
      other.mass >= bot.mass / 2 * CONFIG.rules.eatMassRatio)) return null;
  const prey = others.filter(other => bot.mass / 2 >= other.mass * CONFIG.rules.eatMassRatio * 1.1 &&
    distanceSquared(bot, other) > (bot.radius + other.radius + 10) ** 2 &&
    distanceSquared(bot, other) < (bot.radius + other.radius + 95) ** 2)
    .sort((a, b) => distanceSquared(bot, a) - distanceSquared(bot, b))[0];
  return prey ? { x: prey.x - bot.x, y: prey.y - bot.y } : null;
}
