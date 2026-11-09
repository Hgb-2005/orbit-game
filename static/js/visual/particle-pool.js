const TAU = Math.PI * 2;
const KIND = Object.freeze({ BURST: 0, SWIRL: 1, TRAIL: 2, SPARK: 3 });

function hash(seed) {
  const value = Math.sin(seed * 12.9898) * 43758.5453;
  return value - Math.floor(value);
}

/**
 * 固定容量的表现层粒子池。对象预先分配，运行中不会因为高频进食不断创建数组对象。
 * 粒子的坐标始终是世界坐标；可见性和尺寸由 Canvas 相机变换统一处理。
 */
export class ParticlePool {
  constructor(capacity = 220) {
    this.capacity = Math.max(0, Math.floor(capacity));
    this.items = Array.from({ length: this.capacity }, () => ({
      active: false, kind: KIND.BURST, x: 0, y: 0, vx: 0, vy: 0, ax: 0, ay: 0,
      life: 0, duration: 1, size: 1, endSize: 0, color: "#fff", alpha: 0.8, spin: 0,
    }));
    this.cursor = 0;
    this.seed = 1;
    this.activeCount = 0;
  }

  clear() {
    for (const item of this.items) item.active = false;
    this.activeCount = 0;
  }

  next() {
    if (!this.items.length) return null;
    // 环形游标让内容有界；到达容量时优先复用最老槽位，保持稳定帧成本。
    const item = this.items[this.cursor % this.items.length];
    this.cursor = (this.cursor + 1) % this.items.length;
    if (!item.active) this.activeCount++;
    return item;
  }

  random() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 4294967296 || hash(this.seed + 1);
  }

  emit(x, y, options = {}) {
    const item = this.next();
    if (!item) return null;
    const angle = options.angle ?? this.random() * TAU;
    const speed = options.speed ?? 20 + this.random() * 70;
    Object.assign(item, {
      active: true,
      kind: options.kind ?? KIND.BURST,
      x, y,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
      ax: options.ax ?? 0,
      ay: options.ay ?? 0,
      life: options.life ?? .6,
      duration: options.life ?? .6,
      size: options.size ?? 2.5,
      endSize: options.endSize ?? .2,
      color: options.color ?? "#b4efcc",
      alpha: options.alpha ?? .8,
      spin: options.spin ?? (this.random() - .5) * 2,
    });
    return item;
  }

  burst(x, y, color, count = 8, kind = KIND.BURST) {
    const total = Math.max(0, Math.floor(count));
    for (let index = 0; index < total; index++) {
      const angle = index / Math.max(1, total) * TAU + (this.random() - .5) * .38;
      const speed = kind === KIND.SWIRL ? 35 + this.random() * 95 : 28 + this.random() * 120;
      this.emit(x, y, {
        kind, angle, speed, color,
        life: kind === KIND.SPARK ? .35 + this.random() * .25 : .5 + this.random() * .5,
        size: kind === KIND.SPARK ? 2.2 : 1.5 + this.random() * 3,
        ax: kind === KIND.SWIRL ? -Math.sin(angle) * 70 : 0,
        ay: kind === KIND.SWIRL ? Math.cos(angle) * 70 : 0,
      });
    }
  }

  trail(x, y, color, radius = 10, kind = KIND.TRAIL) {
    const angle = this.random() * TAU;
    this.emit(x + Math.cos(angle) * radius * .5, y + Math.sin(angle) * radius * .5, {
      kind, color, angle: angle + Math.PI, speed: 4 + this.random() * 14,
      life: .28 + this.random() * .28, size: Math.max(1.1, radius * .09), endSize: .1, alpha: .52,
    });
  }

  update(dt, playing = true, limit = this.items.length) {
    if (!playing || dt <= 0) return;
    let active = 0;
    const maxActive = Math.max(0, Math.min(this.items.length, Math.floor(limit)));
    const drag = Math.max(0, 1 - dt * 1.8);
    for (const item of this.items) {
      if (!item.active) continue;
      item.life -= dt;
      if (item.life <= 0) { item.active = false; continue; }
      if (active >= maxActive) {
        item.active = false;
        continue;
      }
      item.vx += item.ax * dt;
      item.vy += item.ay * dt;
      item.vx *= drag;
      item.vy *= drag;
      item.x += item.vx * dt;
      item.y += item.vy * dt;
      active++;
    }
    this.activeCount = active;
  }

  draw(ctx, limit = this.items.length) {
    let glow = null;
    let drawn = 0;
    const maxActive = Math.max(0, Math.min(this.items.length, Math.floor(limit)));
    for (const item of this.items) {
      if (!item.active) continue;
      if (drawn >= maxActive) break;
      const progress = 1 - item.life / item.duration;
      const size = Math.max(.15, item.size + (item.endSize - item.size) * progress);
      ctx.globalAlpha = item.alpha * Math.min(1, item.life / item.duration * 2.4);
      ctx.fillStyle = item.color;
      if (item.kind === KIND.TRAIL || item.kind === KIND.SWIRL) {
        ctx.beginPath();
        ctx.ellipse(item.x, item.y, size * 1.8, Math.max(.4, size * .65),
          Math.atan2(item.vy, item.vx) + item.spin * progress, 0, TAU);
        ctx.fill();
      } else if (item.kind === KIND.SPARK) {
        if (!glow) glow = true;
        ctx.fillRect(item.x - size * .45, item.y - size, size * .9, size * 2);
      } else {
        ctx.beginPath();
        ctx.arc(item.x, item.y, size, 0, TAU);
        ctx.fill();
      }
      drawn++;
    }
    ctx.globalAlpha = 1;
    return glow;
  }
}

export { KIND as PARTICLE_KIND };
