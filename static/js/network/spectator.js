import { summarizeCells } from '../core/cells.js';

/** 观战镜头仅改变观看位置，不产生角色输入；目标出局后自动选择仍存活的人。 */
export class Spectator {
  constructor() { this.reset(); }
  reset() { this.mode = 'follow'; this.ownerId = ''; this.free = null; }
  choices(standings, team) {
    return standings.filter(entry => entry.lives > 0 && entry.cells > 0)
      .map(entry => ({ ...entry, ally: team != null && entry.team === team }))
      .sort((a, b) => Number(b.ally) - Number(a.ally) || a.rank - b.rank);
  }
  select(value, cells, standings, team, bounds) {
    if (value === 'free') {
      const target = this.target(cells, standings, team, bounds);
      this.free = { x: target.x, y: target.y }; this.mode = 'free';
    } else { this.mode = 'follow'; this.ownerId = value; }
  }
  cycle(offset, cells, standings, team, bounds) {
    const choices = this.choices(standings, team);
    if (!choices.length) return;
    const index = choices.findIndex(entry => entry.ownerId === this.ownerId);
    this.select(choices[(Math.max(0, index) + offset + choices.length) % choices.length].ownerId, cells, standings, team, bounds);
  }
  locate(point, bounds) {
    this.mode = 'free';
    this.free = { x: Math.max(0, Math.min(bounds.width, point.x)), y: Math.max(0, Math.min(bounds.height, point.y)) };
  }
  pan(input, dt, bounds) {
    if (this.mode !== 'free' || !this.free) return;
    // 自由镜头只接受明确的键盘/摇杆方向，鼠标悬停不会让镜头不断漂移。
    const x = Number.isFinite(input.panX) ? input.panX : 0, y = Number.isFinite(input.panY) ? input.panY : 0;
    const length = Math.max(1, Math.hypot(x, y));
    this.locate({ x: this.free.x + x / length * 750 * dt, y: this.free.y + y / length * 750 * dt }, bounds);
  }
  target(cells, standings, team, bounds) {
    const fallback = { x: bounds.width / 2, y: bounds.height / 2, radius: 70, viewRadius: 450 };
    if (this.mode === 'free') return { ...fallback, ...(this.free ?? {}) };
    const choices = this.choices(standings, team);
    if (!choices.some(entry => entry.ownerId === this.ownerId)) this.ownerId = choices[0]?.ownerId ?? '';
    return summarizeCells(cells.filter(cell => cell.ownerId === this.ownerId), fallback);
  }
}
