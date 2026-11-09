import { CONFIG } from "../config.js";
import { distanceSquared, hasEatSizeAdvantage } from "./entities.js";
import { BOT_ROLES } from "./progression.js";

export const BOT_SKILLS = Object.freeze({
  casual: { reaction: .5, margin: 1.35, maxCells: 1, rest: 18 },
  standard: { reaction: .28, margin: 1.14, maxCells: 2, rest: 14 },
  challenge: { reaction: .16, margin: 1.08, maxCells: 4, rest: 9 },
});
const unit = (x, y) => { const length = Math.hypot(x, y) || 1; return { x: x / length, y: y / length }; };
const nowFor = world => Number.isFinite(world.elapsed) ? world.elapsed : 0;
const idNumber = value => [...String(value)].reduce((sum, char) => sum + char.charCodeAt(0), 0);

export function segmentDistance(point, start, end) {
  const dx = end.x - start.x, dy = end.y - start.y;
  const t = Math.max(0, Math.min(1, ((point.x - start.x) * dx + (point.y - start.y) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(point.x - start.x - t * dx, point.y - start.y - t * dy);
}

/** 先看前方路径，远处侧绕、贴近向外退；轻球按真实规则可以穿过刺球。 */
export function avoidSpikes(bot, direction, spikes = []) {
  if (bot.mass < CONFIG.spikes.minimumMass) return direction;
  const end = { x: bot.x + direction.x * 160, y: bot.y + direction.y * 160 };
  const danger = spikes.filter(spike => segmentDistance(spike, bot, end) < bot.radius + spike.radius * .72 + 28)
    .sort((a, b) => distanceSquared(bot, a) - distanceSquared(bot, b))[0];
  if (!danger) return direction;
  const ax = bot.x - danger.x, ay = bot.y - danger.y;
  if (Math.hypot(ax, ay) < bot.radius + danger.radius * .72 + 18) return unit(ax || 1, ay);
  const normal = unit(ax, ay), side = direction.x * -normal.y + direction.y * normal.x >= 0 ? 1 : -1;
  return unit(direction.x * .25 - normal.y * side + normal.x * .5, direction.y * .25 + normal.x * side + normal.y * .5);
}

/** 决策只返回方向，AI 不直接修改位置；未来可完整迁移到服务器。 */
export function chooseBotDirection(bot, world) {
  const others = [...world.playerCells, ...world.bots];
  const now = nowFor(world);
  const difficulty = Object.hasOwn(BOT_SKILLS, world.botDifficulty) ? world.botDifficulty : "standard";
  let threat = null;
  let prey = null;
  let threatDistance = Infinity;
  let preyDistance = Infinity;
  const role = BOT_ROLES[bot.role] ?? BOT_ROLES.rival;
  const siblings = others.filter(other => other.ownerId === bot.ownerId && other.alive);
  let threatenedCell = bot;

  // 休闲档只觅食和漫游，不读取敌人信息；这是难度差异，不改变移动或吞噬规则。
  if (difficulty !== "casual") {
    const enemies = others.filter(other => other.ownerId !== bot.ownerId && other.alive &&
      !world.itemSystem?.hiddenFrom(other.ownerId, bot.ownerId) &&
      !world.isProtected?.(other) && !(other.isPlayer && world.protectionRemaining > 0));
    for (const other of enemies) {
      const distance = distanceSquared(bot, other);
      for (const cell of siblings) {
        const gap = Math.hypot(other.x - cell.x, other.y - cell.y) - other.radius - cell.radius;
        if (hasEatSizeAdvantage(other, cell) && gap < 220 && gap < threatDistance) {
          threat = other; threatDistance = gap; threatenedCell = cell;
        }
      }
      if (hasEatSizeAdvantage(bot, other) &&
          distance < (role.chaseRange + bot.radius) ** 2 && distance < preyDistance) {
        prey = other;
        preyDistance = distance;
      }
    }

    // 目标记忆避免 AI 每隔几十毫秒在等距目标之间来回抖动。
    if (bot.targetUntil > now && bot.targetId) {
      const remembered = enemies.find(other => other.id === bot.targetId);
      if (bot.targetKind === "threat" && remembered) {
        const ownerCells = siblings.filter(cell => hasEatSizeAdvantage(remembered, cell));
        const nearest = ownerCells.sort((a, b) => distanceSquared(a, remembered) - distanceSquared(b, remembered))[0];
        const gap = nearest && Math.hypot(remembered.x - nearest.x, remembered.y - nearest.y) -
          remembered.radius - nearest.radius;
        // 记忆只抑制短时间内的目标抖动，不能让已经远离的旧目标覆盖新的觅食或收拢决策。
        if (nearest && gap < 220) {
          threat = remembered;
          threatenedCell = nearest;
        }
      } else if (bot.targetKind === "prey" && remembered && hasEatSizeAdvantage(bot, remembered) &&
          distanceSquared(bot, remembered) < (role.chaseRange + bot.radius) ** 2) {
        prey = remembered;
      }
    }
  }

  let dx;
  let dy;
  if (threat) {
    dx = threatenedCell.x - threat.x;
    dy = threatenedCell.y - threat.y;
    rememberTarget(bot, "threat", threat.id, now);
  } else if (prey) {
    dx = prey.x - bot.x;
    dy = prey.y - bot.y;
    // 挑战档会预判目标移动；标准档仍走最短直线，便于玩家读懂。
    if (difficulty === "challenge") {
      dx += (prey.vx ?? 0) * .18;
      dy += (prey.vy ?? 0) * .18;
    }
    rememberTarget(bot, "prey", prey.id, now);
  } else {
    const item = difficulty === "casual" ? null : (world.itemSystem?.items ?? [])
      .filter(candidate => candidate.x >= 0 && candidate.y >= 0)
      .sort((a, b) => distanceSquared(bot, a) - distanceSquared(bot, b))[0];
    if (item && distanceSquared(bot, item) < (role.forageRange ?? 620) ** 2) {
      // 安全时优先拿道具；敌人和猎物仍拥有更高决策优先级。
      dx = item.x - bot.x;
      dy = item.y - bot.y;
      rememberTarget(bot, "item", item.id, now);
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
      if (closest) {
        dx = closest.x - bot.x;
        dy = closest.y - bot.y;
        rememberTarget(bot, "food", closest.id, now);
      } else {
        const angle = idNumber(bot.id) * .37 + now * .17;
        dx = Math.cos(angle);
        dy = Math.sin(angle);
        rememberTarget(bot, "wander", null, now);
      }
    }
  }

  if (!threat && siblings.length > 1) {
    const total = siblings.reduce((sum, cell) => sum + cell.mass, 0);
    const center = { x: siblings.reduce((sum, cell) => sum + cell.x * cell.mass, 0) / total,
      y: siblings.reduce((sum, cell) => sum + cell.y * cell.mass, 0) / total };
    if (siblings.some(cell => Math.hypot(cell.x - center.x, cell.y - center.y) > 140)) {
      dx = center.x - bot.x; dy = center.y - bot.y;
    }
  }
  if (Math.hypot(dx, dy) < .001) return { x: 0, y: 0 };
  let direction = unit(dx, dy);
  // 只有挑战档会主动绕刺；简单档被刺扎到后才按真实规则分裂。
  if (difficulty === "challenge") direction = avoidSpikes(bot, direction, world.spikes ?? []);
  dx = direction.x;
  dy = direction.y;

  // 靠近边界时施加回到场内的力，防止逃跑的 AI 长时间贴墙不动。
  const edge = bot.radius + 65;
  if (bot.x < edge) dx += .9;
  if (bot.x > world.bounds.width - edge) dx -= .9;
  if (bot.y < edge) dy += .9;
  if (bot.y > world.bounds.height - edge) dy -= .9;
  const length = Math.hypot(dx, dy) || 1;
  return { x: dx / length, y: dy / length };
}

function rememberTarget(bot, kind, id, now) {
  bot.targetKind = kind;
  bot.targetId = id;
  bot.targetUntil = now + CONFIG.bots.targetMemorySeconds;
}

/** 追猎者只在分裂后仍能吃掉目标、且附近没有强敌时尝试弹射。 */
export function chooseBotSplit(bot, world) {
  const skill = BOT_SKILLS[world.botDifficulty] ?? BOT_SKILLS.standard;
  // 分裂追猎是挑战档专属技能，标准档只追直线，避免基础局突然恶化。
  if (world.botDifficulty !== "challenge" || skill.maxCells === 1) return null;
  if (world.isProtected?.(bot)) return null;
  if (!(bot.role === "hunter" || bot.role === "rival") || bot.mass < CONFIG.split.minimumMass) return null;
  const others = [...world.playerCells, ...world.bots].filter(other =>
    other.alive && other.ownerId !== bot.ownerId && !world.isProtected?.(other) && !(other.isPlayer && world.protectionRemaining > 0));
  const splitRadius = Math.sqrt(bot.mass / 2) * CONFIG.rules.radiusScale;
  if (others.some(other => distanceSquared(bot, other) < (bot.radius + other.radius + 180) ** 2 &&
      other.radius > splitRadius * CONFIG.rules.eatRadiusRatio)) return null;
  const prey = others.filter(other => splitRadius > other.radius * CONFIG.rules.eatRadiusRatio * skill.margin &&
    distanceSquared(bot, other) > (bot.radius + other.radius + 10) ** 2 &&
    distanceSquared(bot, other) < (bot.radius + other.radius + 95) ** 2 &&
    !(world.spikes ?? []).some(spike => segmentDistance(spike, bot, other) < bot.radius + spike.radius + 20))
    .sort((a, b) => distanceSquared(bot, a) - distanceSquared(bot, b))[0];
  return prey ? { x: prey.x - bot.x, y: prey.y - bot.y } : null;
}
