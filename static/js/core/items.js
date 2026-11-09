import { CONFIG } from "../config.js";
import { distanceSquared } from "./entities.js";

const TYPES = Object.keys(CONFIG.items.types);

/**
 * 单机道具系统。道具刷新、拾取、持续时间和磁铁移动全部在这里处理，
 * World 只调用 update/pickup 等入口，后续联机可复用相同的快照结构。
 */
export class ItemSystem {
  constructor(random = Math.random) {
    this.random = random;
    this.reset("standard");
  }

  reset(mode = "standard") {
    this.mode = Object.hasOwn(CONFIG.items.modes, mode) ? mode : "standard";
    this.items = [];
    this.effects = new Map();
    this.blockTimes = new Map();
    this.combos = new Map();
    this.refillTimer = 0;
    this.nextId = 0;
    this.elapsed = 0;
    const target = CONFIG.items.modes[this.mode].maxCount;
    while (this.items.length < target) this.items.push(this.createItem());
  }

  createItem() {
    const type = TYPES[Math.floor(this.random() * TYPES.length)];
    return {
      id: `item-${this.nextId++}`,
      type,
      x: 24 + this.random() * (CONFIG.world.width - 48),
      y: 24 + this.random() * (CONFIG.world.height - 48),
      radius: 12,
      color: CONFIG.items.types[type].color,
      symbol: CONFIG.items.types[type].symbol,
    };
  }

  ownerEffects(ownerId) {
    return this.effects.get(ownerId) ?? {};
  }

  active(ownerId, type) {
    return (this.ownerEffects(ownerId)[type] ?? 0) > this.elapsed;
  }

  shieldActive(ownerId) {
    return this.active(ownerId, "shield");
  }

  speedMultiplier(ownerId) {
    return this.active(ownerId, "speed") ? CONFIG.items.speedMultiplier : 1;
  }

  cloakActive(ownerId) {
    return this.active(ownerId, "cloak");
  }

  hiddenFrom(ownerId, observerId) {
    return ownerId !== observerId && this.cloakActive(ownerId);
  }

  apply(ownerId, type) {
    const definition = CONFIG.items.types[type];
    if (!definition) return false;
    const current = this.ownerEffects(ownerId);
    // 重复拾取只刷新持续时间，不叠加倍率或额外护盾层数。
    this.effects.set(ownerId, { ...current, [type]: this.elapsed + definition.duration });
    return true;
  }

  clearOwner(ownerId) {
    this.effects.delete(ownerId);
    this.blockTimes.delete(ownerId);
    this.combos.delete(ownerId);
  }

  registerEat(ownerId) {
    const current = this.combos.get(ownerId);
    const count = current && current.lastAt + CONFIG.items.comboWindow >= this.elapsed
      ? current.count + 1 : 1;
    const combo = { count, lastAt: this.elapsed };
    this.combos.set(ownerId, combo);
    return combo;
  }

  combo(ownerId) {
    const value = this.combos.get(ownerId);
    return value && value.lastAt + CONFIG.items.comboWindow >= this.elapsed
      ? { count: value.count, remaining: value.lastAt + CONFIG.items.comboWindow - this.elapsed,
        window: CONFIG.items.comboWindow }
      : { count: 0, remaining: 0, window: CONFIG.items.comboWindow };
  }

  recordShieldBlock(ownerId, blockedBy) {
    if ((this.blockTimes.get(ownerId) ?? -Infinity) + .75 > this.elapsed) return false;
    this.blockTimes.set(ownerId, this.elapsed);
    return blockedBy;
  }

  update(dt, world) {
    this.elapsed = world.elapsed;
    const events = [];
    for (const [ownerId, effects] of this.effects) {
      const active = Object.fromEntries(Object.entries(effects)
        .filter(([, until]) => until > this.elapsed));
      if (Object.keys(active).length) this.effects.set(ownerId, active);
      else {
        this.effects.delete(ownerId);
        for (const type of Object.keys(effects)) {
          events.push({ type: "effect-end", ownerId, isPlayer: ownerId === "player",
            itemType: type, label: CONFIG.items.types[type]?.label ?? type });
        }
      }
      for (const [type, until] of Object.entries(effects)) {
        if (!(type in active) && Object.keys(active).length) {
          events.push({ type: "effect-end", ownerId, isPlayer: ownerId === "player",
            itemType: type, label: CONFIG.items.types[type]?.label ?? type });
        }
      }
    }
    for (const [ownerId, blockedAt] of this.blockTimes) {
      if (blockedAt + .75 <= this.elapsed) this.blockTimes.delete(ownerId);
    }

    this.applyMagnet(dt, world);
    this.pickup(world);

    const target = CONFIG.items.modes[this.mode].maxCount;
    const interval = CONFIG.items.modes[this.mode].refillInterval;
    if (interval > 0 && this.items.length < target) {
      this.refillTimer += dt;
      while (this.refillTimer >= interval && this.items.length < target) {
        this.refillTimer -= interval;
        this.items.push(this.createItem());
        events.push({ type: "item-spawn" });
      }
    } else {
      this.refillTimer = 0;
    }
    return events.filter(event => event.type === "effect-end");
  }

  pickup(world) {
    const balls = [...world.playerCells, ...world.bots].filter(ball => ball.alive);
    this.items = this.items.filter(item => {
      const ball = balls.find(candidate =>
        distanceSquared(candidate, item) <= (candidate.radius + CONFIG.items.pickupPadding) ** 2);
      if (!ball) return true;
      this.apply(ball.ownerId, item.type);
      if (ball.isPlayer) {
        world.events.push({ type: "item", ownerId: ball.ownerId, isPlayer: ball.isPlayer,
          itemType: item.type, x: item.x, y: item.y,
          color: item.color, label: CONFIG.items.types[item.type].label });
      }
      return false;
    });
  }

  applyMagnet(dt, world) {
    for (const [ownerId, effects] of this.effects) {
      if ((effects.magnet ?? 0) <= this.elapsed) continue;
      const cells = ownerId === "player" ? world.playerCells
        : world.bots.filter(ball => ball.ownerId === ownerId);
      const source = cells.filter(cell => cell.alive).sort((a, b) => b.mass - a.mass)[0];
      if (!source) continue;
      for (const food of world.foods) {
        if (distanceSquared(source, food) > CONFIG.items.magnetRadius ** 2) continue;
        const dx = source.x - food.x;
        const dy = source.y - food.y;
        const distance = Math.hypot(dx, dy);
        if (distance < .001) continue;
        const step = Math.min(distance, CONFIG.items.magnetSpeed * dt);
        food.x = Math.max(food.radius, Math.min(CONFIG.world.width - food.radius,
          food.x + dx / distance * step));
        food.y = Math.max(food.radius, Math.min(CONFIG.world.height - food.radius,
          food.y + dy / distance * step));
      }
    }
  }

  snapshot(playerId = "player") {
    return {
      mode: this.mode,
      items: this.items.map(item => ({ ...item })),
      effects: Object.fromEntries([...this.effects].map(([ownerId, effects]) => [ownerId, { ...effects }])),
      combo: this.combo(playerId),
    };
  }
}
