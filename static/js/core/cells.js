import { CONFIG } from "../config.js";
import { clamp, createBall, distanceSquared, growBall } from "./entities.js";

/** 球群摘要只用于镜头、HUD 和技能预算；碰撞始终使用每个分身的真实质量。 */
export function summarizeCells(cells, fallback) {
  const live = cells.filter(cell => cell.alive);
  if (!live.length) return { ...fallback, alive: false, mass: 0, speed: 0, viewRadius: fallback.radius,
    largestMass: 0, smallestMass: 0, averageMass: 0, cellMasses: [] };
  const largest = live.reduce((a, b) => a.mass >= b.mass ? a : b);
  const mass = live.reduce((sum, cell) => sum + cell.mass, 0);
  const masses = live.map(cell => cell.mass).sort((a, b) => b - a);
  const weighted = key => live.reduce((sum, cell) => sum + cell[key] * cell.mass, 0) / mass;
  const center = { x: weighted("x"), y: weighted("y") };
  return {
    ...largest, ...center, mass, radius: Math.sqrt(mass) * CONFIG.rules.radiusScale,
    speed: weighted("speed"), vx: weighted("vx"), vy: weighted("vy"),
    largestMass: masses[0], smallestMass: masses[masses.length - 1], averageMass: mass / masses.length,
    cellMasses: masses,
    viewRadius: Math.max(...live.map(cell => Math.sqrt(distanceSquared(cell, center)) + cell.radius)),
  };
}

/** 单次按键按质量从大到小分裂，每个原有球最多分裂一次。 */
export function splitCells(cells, direction, bounds, nextId, maxCells = CONFIG.split.maxCells) {
  const length = Math.hypot(direction.x, direction.y);
  if (length < 0.05 || cells.length >= maxCells) return [];
  const dx = direction.x / length;
  const dy = direction.y / length;
  const sources = [...cells].filter(cell => cell.alive && cell.mass >= CONFIG.split.minimumMass)
    .sort((a, b) => b.mass - a.mass).slice(0, maxCells - cells.length);
  const children = [];
  for (const source of sources) {
    const mass = source.mass / 2;
    growBall(source, -mass);
    const child = createBall({
      id: nextId(), ownerId: source.ownerId, x: source.x, y: source.y, mass,
      name: source.name, color: source.color, isPlayer: source.isPlayer,
    });
    child.role = source.role;
    child.direction = { ...source.direction };
    child.vx = source.vx;
    child.vy = source.vy;
    child.impulseX = dx * CONFIG.split.launchSpeed;
    child.impulseY = dy * CONFIG.split.launchSpeed;
    // 很短的初始偏移给弹射一个明确方向，剩余距离由移动积分完成。
    child.x = clamp(source.x + dx * source.radius * 0.65, child.radius, bounds.width - child.radius);
    child.y = clamp(source.y + dy * source.radius * 0.65, child.radius, bounds.height - child.radius);
    source.mergeRemaining = CONFIG.split.mergeDelay;
    child.mergeRemaining = CONFIG.split.mergeDelay;
    children.push(child);
  }
  cells.push(...children);
  return children;
}

export function clampCell(cell, bounds) {
  cell.x = clamp(cell.x, cell.radius, bounds.width - cell.radius);
  cell.y = clamp(cell.y, cell.radius, bounds.height - cell.radius);
}

/** 冷却前分身互相避让；两球均可合体时靠拢，足够接近后按质量加权合并。 */
export function updateCellGroup(cells, dt, bounds) {
  for (const cell of cells) cell.mergeRemaining = Math.max(0, cell.mergeRemaining - dt);
  for (let i = 0; i < cells.length; i++) {
    const a = cells[i];
    if (!a.alive) continue;
    for (let j = i + 1; j < cells.length; j++) {
      const b = cells[j];
      if (!b.alive || a.ownerId !== b.ownerId) continue;
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const distance = Math.hypot(dx, dy);
      const nx = distance > 0.001 ? dx / distance : 1;
      const ny = distance > 0.001 ? dy / distance : 0;
      const ready = a.mergeRemaining === 0 && b.mergeRemaining === 0;
      const sum = a.mass + b.mass;
      if (ready && distance <= (a.radius + b.radius) * 0.65) {
        a.x = (a.x * a.mass + b.x * b.mass) / sum;
        a.y = (a.y * a.mass + b.y * b.mass) / sum;
        a.vx = (a.vx * a.mass + b.vx * b.mass) / sum;
        a.vy = (a.vy * a.mass + b.vy * b.mass) / sum;
        a.impulseX = (a.impulseX * a.mass + b.impulseX * b.mass) / sum;
        a.impulseY = (a.impulseY * a.mass + b.impulseY * b.mass) / sum;
        growBall(a, b.mass);
        b.alive = false;
      } else {
        const overlap = a.radius + b.radius - distance;
        const shift = ready ? Math.min(distance * 0.25, CONFIG.split.regroupSpeed * dt) :
          overlap > 0 ? -overlap * (1 - Math.exp(-18 * dt)) : 0;
        a.x += nx * shift * b.mass / sum;
        a.y += ny * shift * b.mass / sum;
        b.x -= nx * shift * a.mass / sum;
        b.y -= ny * shift * a.mass / sum;
      }
      clampCell(a, bounds);
      clampCell(b, bounds);
    }
  }
  return cells.filter(cell => cell.alive);
}

/** 冷却与按键边沿属于控制者，分身被吞后不会复制或重置技能。 */
export class SplitAbility {
  constructor() {
    this.cooldown = 0;
    this.wasPressed = false;
  }

  update(dt, input, cells, bounds, nextId) {
    this.cooldown = Math.max(0, this.cooldown - dt);
    const pressed = Boolean(input.split);
    const group = summarizeCells(cells, cells[0]);
    const targetAim = input.target ? { x: input.target.x - group.x, y: input.target.y - group.y } : input;
    const aim = Math.hypot(targetAim.x, targetAim.y) > 0.05 ? targetAim : { x: group.vx, y: group.vy };
    let children = [];
    if (pressed && !this.wasPressed && this.cooldown === 0) {
      children = splitCells(cells, aim, bounds, nextId);
      if (children.length) this.cooldown = CONFIG.split.cooldown;
    }
    this.wasPressed = pressed;
    return children;
  }

  getSnapshot(cells) {
    const count = cells.length;
    const affordable = cells.some(cell => cell.mass >= CONFIG.split.minimumMass);
    const mergeRemaining = count > 1 ? Math.max(...cells.map(cell => cell.mergeRemaining)) : 0;
    return {
      count, maxCells: CONFIG.split.maxCells, affordable, cooldown: this.cooldown,
      ready: count < CONFIG.split.maxCells && affordable && this.cooldown === 0,
      mergeRemaining, merging: count > 1 && mergeRemaining === 0,
    };
  }
}
