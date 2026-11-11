import { CONFIG } from "../config.js";
import { DEFAULT_APPEARANCE, normalizeAppearance } from "../skins/catalog.js";

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
export const distanceSquared = (a, b) => (a.x - b.x) ** 2 + (a.y - b.y) ** 2;

export function speedForMass(mass) {
  return Math.max(CONFIG.player.minimumSpeed,
    CONFIG.player.baseSpeed * (CONFIG.player.initialMass / mass) ** 0.25);
}

/** 实体使用普通数据对象，方便日后通过 WebSocket 序列化快照。 */
export function createBall({
  id,
  x,
  y,
  mass,
  name,
  color,
  isPlayer = false,
  ownerId = isPlayer ? "player" : id,
  ballSkin = DEFAULT_APPEARANCE.ballSkin,
  sporeSkin = DEFAULT_APPEARANCE.sporeSkin,
}) {
  const appearance = normalizeAppearance({ ballSkin, sporeSkin });
  return {
    id, ownerId, x, y, mass, name, color, isPlayer,
    ...appearance,
    radius: Math.sqrt(mass) * CONFIG.rules.radiusScale,
    speed: speedForMass(mass),
    vx: 0, vy: 0,
    direction: { x: 0, y: 0 },
    thinkTimer: 0,
    alive: true,
    mergeRemaining: 0,
    impulseX: 0, impulseY: 0,
    // 扎刺保护窗口，避免同一颗刺球在连续帧里重复触发。
    spikeCooldown: 0,
  };
}

export function growBall(ball, mass) {
  ball.mass += mass;
  ball.radius = Math.sqrt(ball.mass) * CONFIG.rules.radiusScale;
  ball.speed = speedForMass(ball.mass);
}

/** 吞噬体型优势的唯一判定；距离和完全包含由 canEat 继续检查。 */
export function hasEatSizeAdvantage(eater, prey) {
  return eater.radius > prey.radius * CONFIG.rules.eatRadiusRatio;
}

/** 相同规则用于玩家和 AI，吞噬判断与绘制效果相互独立。 */
export function canEat(eater, prey) {
  // 同一控制者的分身只能走合体规则，不能互相吞噬、刷分。
  if (eater.ownerId === prey.ownerId) return false;
  if (!eater.alive || !prey.alive || !hasEatSizeAdvantage(eater, prey)) return false;
  return distanceSquared(eater, prey) < (eater.radius - prey.radius) ** 2;
}

/**
 * 所有位置修正的唯一入口。clamp 夹住并清除向外速度；bounce 反转速度并乘恢复系数。
 * 半径大到超过地图半宽时仍返回安全中心，保证不会出现 min > max 的无效值。
 */
export function resolveBallBounds(ball, bounds, policy = CONFIG.rules.boundaryPolicy,
  restitution = CONFIG.rules.boundaryRestitution) {
  const fixAxis = (positionKey, velocityKey, impulseKey, size) => {
    if (ball.radius * 2 >= size) {
      ball[positionKey] = size / 2;
      ball[velocityKey] = 0;
      if (impulseKey && impulseKey in ball) ball[impulseKey] = 0;
      return;
    }
    const min = ball.radius;
    const max = size - ball.radius;
    if (ball[positionKey] < min) {
      ball[positionKey] = min;
      if (policy === "bounce" && ball[velocityKey] < 0) {
        ball[velocityKey] = -ball[velocityKey] * restitution;
        if (impulseKey && impulseKey in ball && ball[impulseKey] < 0) ball[impulseKey] *= -restitution;
      } else if (ball[velocityKey] < 0) {
        ball[velocityKey] = 0;
        if (impulseKey && impulseKey in ball) ball[impulseKey] = 0;
      }
    } else if (ball[positionKey] > max) {
      ball[positionKey] = max;
      if (policy === "bounce" && ball[velocityKey] > 0) {
        ball[velocityKey] = -ball[velocityKey] * restitution;
        if (impulseKey && impulseKey in ball && ball[impulseKey] > 0) ball[impulseKey] *= -restitution;
      } else if (ball[velocityKey] > 0) {
        ball[velocityKey] = 0;
        if (impulseKey && impulseKey in ball) ball[impulseKey] = 0;
      }
    }
  };
  fixAxis("x", "vx", "impulseX", bounds.width);
  fixAxis("y", "vy", "impulseY", bounds.height);
  return ball;
}

export function moveBall(ball, direction, dt, bounds, speedMultiplier = 1) {
  const length = Math.hypot(direction.x, direction.y);
  const scale = length > 1 ? 1 / length : 1;
  // 指针靠近球心时可以减速；插值让转弯和停止更自然。
  const smoothing = 1 - Math.exp(-12 * dt);
  ball.vx += (direction.x * scale * ball.speed * speedMultiplier - ball.vx) * smoothing;
  ball.vy += (direction.y * scale * ball.speed * speedMultiplier - ball.vy) * smoothing;
  // 弹射独立于普通移动速度，指数衰减；使用积分使不同步长下的距离一致。
  const decay = Math.exp(-CONFIG.split.launchDecay * dt);
  const impulseTime = (1 - decay) / CONFIG.split.launchDecay;
  ball.x += ball.vx * dt + ball.impulseX * impulseTime;
  ball.y += ball.vy * dt + ball.impulseY * impulseTime;
  ball.impulseX *= decay;
  ball.impulseY *= decay;
  resolveBallBounds(ball, bounds);
}
