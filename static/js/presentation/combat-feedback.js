import { CONFIG } from "../config.js";

/** 按单个分身评估威胁，球群总质量不能替小分身提供保护。 */
export function nearestDanger(snapshot) {
  if (snapshot.state !== "playing" || snapshot.spectating || snapshot.protectionRemaining > 0) return null;
  const protectedOwners = snapshot.survival?.protectionByOwner || {};
  let nearest = null;
  for (const cell of snapshot.playerCells) {
    if (!cell.alive || protectedOwners[cell.ownerId] > 0) continue;
    for (const enemy of snapshot.bots) {
      if (!enemy.alive || enemy.isAlly || protectedOwners[enemy.ownerId] > 0 ||
          enemy.mass < cell.mass * CONFIG.rules.eatMassRatio) continue;
      const gap = Math.hypot(enemy.x - cell.x, enemy.y - cell.y) - enemy.radius - cell.radius;
      if (gap > 240 || nearest && nearest.gap <= gap) continue;
      nearest = { cell, enemy, gap };
    }
  }
  return nearest;
}

/** 有上限的表现状态。食物按 180ms 合并，暂停只冻结效果，不改变玩法。 */
export class CombatFeedback {
  constructor() { this.reset(); }
  reset() { this.floats = []; this.rings = []; this.food = null; }

  add(events) {
    for (const event of events) {
      if (!Number.isFinite(event.x) || !Number.isFinite(event.y)) continue;
      if (event.type === "food") {
        if (!this.food) this.food = { x: 0, y: 0, mass: 0, age: 0 };
        const mass = event.mass || 1;
        this.food.x += event.x * mass; this.food.y += event.y * mass; this.food.mass += mass;
        continue;
      }
      const text = event.type === "eat" || event.type === "spore-eat" ? `+${Math.round(event.mass || 0)} m` :
        event.type === "celllost" ? `−${Math.round(event.mass || 0)} m` :
        event.type === "spike" ? "扎刺 −8%" : event.type === "spike-launch" ? "反击刺！" : "";
      const bad = ["celllost", "spike"].includes(event.type);
      if (text) this.addFloat({ ...event, text, bad, duration: 1.1, life: 1.1 });
      if (["eat", "spore-eat", "split", "merge", "celllost", "spike", "spike-feed", "spike-launch"].includes(event.type)) {
        this.rings.push({ ...event, bad, life: .55, duration: .55 });
        this.rings = this.rings.slice(-32);
      }
    }
  }

  addFloat(item) { this.floats.push(item); this.floats = this.floats.slice(-24); }

  update(dt, playing) {
    if (!playing) return;
    for (const item of [...this.floats, ...this.rings]) item.life -= dt;
    this.floats = this.floats.filter(item => item.life > 0);
    this.rings = this.rings.filter(item => item.life > 0);
    if (this.food) {
      this.food.age += dt;
      if (this.food.age >= .18) {
        const food = this.food;
        this.addFloat({ x: food.x / food.mass, y: food.y / food.mass, text: `+${Math.round(food.mass)}`,
          small: true, life: .65, duration: .65 });
        this.food = null;
      }
    }
  }
}
