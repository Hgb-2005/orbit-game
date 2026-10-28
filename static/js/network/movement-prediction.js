import { clamp, moveBall } from '../core/entities.js';

const MAX_HISTORY = .5;
const MAX_FRAMES = 120;

/** 只预测自己的移动坐标。分裂、合体、质量、吞噬与生命均等权威快照。 */
export class MovementPrediction {
  constructor() { this.reset(); }

  reset() {
    this.cells = new Map();
    this.frames = [];
    this.seconds = 0;
    this.enabled = false;
    this.blockedAck = null;
    this.signature = '';
    this.correction = 0;
  }

  reconcile(world, playerId) {
    const own = world.cells.filter(cell => cell.ownerId === playerId);
    const owner = world.players.find(player => player.ownerId === playerId);
    // 旧快照缺少独立的运动分量时继续使用原来的位置平滑。
    if (world.finished || !own.length || !Number.isInteger(owner?.ack) ||
        own.some(cell => !['vx', 'vy', 'impulseX', 'impulseY'].every(key => Number.isFinite(cell.motion?.[key])))) {
      this.reset(); return false;
    }
    const signature = own.map(cell => cell.id).sort().join('|');
    const topologyChanged = Boolean(this.signature && signature !== this.signature);
    if (topologyChanged) { this.frames = []; this.blockedAck = null; }
    this.signature = signature;
    this.frames = this.frames.filter(frame => frame.seq > owner.ack);
    this.seconds = this.frames.reduce((total, frame) => total + frame.dt, 0);
    if (this.blockedAck !== null && owner.ack > this.blockedAck) this.blockedAck = null;
    this.ack = owner.ack;
    this.bounds = world.bounds;
    const previous = this.cells;
    this.cells = new Map(own.map(cell => [cell.id, { ...cell, ...cell.motion }]));
    for (const frame of this.frames) this.simulate(frame.dt, frame.input);
    this.correction = Math.max(0, ...[...this.cells].map(([id, cell]) => {
      const before = previous.get(id);
      return before ? Math.hypot(cell.x - before.x, cell.y - before.y) : 0;
    }));
    this.enabled = this.blockedAck === null;
    return topologyChanged;
  }

  advance(dt, input, seq) {
    if (!this.enabled || !(dt > 0)) return new Map();
    dt = Math.min(.1, dt);
    if (this.seconds + dt > MAX_HISTORY || this.frames.length >= MAX_FRAMES) {
      // 没有收到确认时不无限漂移，也不无限保存输入。等新确认后再恢复预测。
      this.frames = []; this.seconds = 0; this.enabled = false; this.blockedAck = this.ack;
      return new Map();
    }
    const controls = {
      x: clamp(Number(input.x) || 0, -1, 1), y: clamp(Number(input.y) || 0, -1, 1),
      target: Number.isFinite(input.target?.x) && Number.isFinite(input.target?.y)
        ? { x: clamp(input.target.x, 0, this.bounds.width), y: clamp(input.target.y, 0, this.bounds.height) } : null,
      regroup: Boolean(input.regroup),
    };
    const before = new Map([...this.cells].map(([id, cell]) => [id, { x: cell.x, y: cell.y }]));
    this.frames.push({ dt, seq, input: controls }); this.seconds += dt;
    this.simulate(dt, controls);
    return new Map([...this.cells].map(([id, cell]) => [id, { x: cell.x - before.get(id).x, y: cell.y - before.get(id).y }]));
  }

  simulate(dt, input) {
    const cells = [...this.cells.values()];
    // 限制积分步长，低帧率与重放时仍使用同样的转向、弹射衰减和地图边界。
    const steps = Math.max(1, Math.ceil(dt / (1 / 60)));
    const step = dt / steps;
    for (let i = 0; i < steps; i++) {
      const mass = cells.reduce((sum, cell) => sum + cell.mass, 0);
      const target = input.regroup && cells.length > 1 ? {
        x: cells.reduce((sum, cell) => sum + cell.x * cell.mass, 0) / mass,
        y: cells.reduce((sum, cell) => sum + cell.y * cell.mass, 0) / mass,
      } : input.target;
      for (const cell of cells) {
        let direction = { x: input.x, y: input.y };
        if (target) {
          const x = target.x - cell.x, y = target.y - cell.y, length = Math.hypot(x, y);
          const strength = clamp((length - 5) / 75, 0, 1);
          direction = length ? { x: x / length * strength, y: y / length * strength } : { x: 0, y: 0 };
        }
        moveBall(cell, direction, step, this.bounds);
        cell.mergeRemaining = Math.max(0, cell.mergeRemaining - step);
      }
      this.separate(cells, step);
    }
  }

  separate(cells, dt) {
    for (let i = 0; i < cells.length; i++) for (let j = i + 1; j < cells.length; j++) {
      const a = cells[i], b = cells[j];
      const dx = b.x - a.x, dy = b.y - a.y, distance = Math.hypot(dx, dy);
      const ready = a.mergeRemaining === 0 && b.mergeRemaining === 0;
      // 已接近合体的球交给下一份服务器快照，客户端不删除球或转移质量。
      if (ready && distance <= (a.radius + b.radius) * .65) continue;
      const overlap = a.radius + b.radius - distance;
      const shift = ready ? Math.min(distance * .25, 260 * dt) : overlap > 0 ? -overlap * (1 - Math.exp(-18 * dt)) : 0;
      const nx = distance > .001 ? dx / distance : 1, ny = distance > .001 ? dy / distance : 0;
      const total = a.mass + b.mass;
      a.x += nx * shift * b.mass / total; a.y += ny * shift * b.mass / total;
      b.x -= nx * shift * a.mass / total; b.y -= ny * shift * a.mass / total;
      for (const cell of [a, b]) {
        cell.x = clamp(cell.x, cell.radius, this.bounds.width - cell.radius);
        cell.y = clamp(cell.y, cell.radius, this.bounds.height - cell.radius);
      }
    }
  }
}
