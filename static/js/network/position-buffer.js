/** 对手位置按服务器时间插值。只影响画面，质量、碰撞与胜负仍来自权威快照。 */
export class PositionBuffer {
  constructor() { this.reset(); }

  reset() {
    this.frames = [];
    this.jitter = 0;
    this.delay = .05;
  }

  push(world, now = performance.now()) {
    const previous = this.frames.at(-1);
    if (previous && world.elapsed < previous.time) return;
    if (previous && world.elapsed > previous.time) {
      const variation = Math.abs(now - previous.arrivedAt - (world.elapsed - previous.time) * 1000);
      this.jitter = this.jitter * .8 + variation * .2;
      this.delay = Math.min(.13, .05 + this.jitter * .002);
    }
    const frame = { time: world.elapsed, arrivedAt: now, cells: new Map(world.cells.map(cell => [cell.id, cell])) };
    if (previous?.time === frame.time) this.frames[this.frames.length - 1] = frame;
    else this.frames.push(frame);
    // 历史只用于短时间绘制；长时间断线不会积压快照。
    this.frames = this.frames.slice(-10);
  }

  sample(cell, now = performance.now()) {
    const latest = this.frames.at(-1);
    if (!latest) return { x: cell.x, y: cell.y };
    const target = latest.time + Math.min(.25, Math.max(0, (now - latest.arrivedAt) / 1000)) - this.delay;
    let before = null, after = null;
    for (const frame of this.frames) {
      if (frame.time <= target) before = frame;
      else { after = frame; break; }
    }
    const a = before?.cells.get(cell.id), b = after?.cells.get(cell.id);
    if (a && b && after.time - before.time <= .25) {
      const t = Math.max(0, Math.min(1, (target - before.time) / (after.time - before.time)));
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    if (!before) return b ? { x: b.x, y: b.y } : { x: cell.x, y: cell.y };
    // 超过最新帧只做最多 100ms 外推，掉线时不会让球一直漂移。
    const extra = Math.min(.1, Math.max(0, target - latest.time));
    return { x: cell.x + Number(cell.vx || 0) * extra, y: cell.y + Number(cell.vy || 0) * extra };
  }
}
