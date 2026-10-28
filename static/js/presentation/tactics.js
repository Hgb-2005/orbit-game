import { CONFIG } from '../config.js';
import { clamp } from '../core/entities.js';

export const SIGNAL_NAMES = Object.freeze({ gather: '这里集合', help: '需要支援', danger: '这里危险' });
export const SIGNAL_COLORS = Object.freeze({ gather: '#72cfa5', help: '#e0bd80', danger: '#e58f92' });

export function abilityReason(snapshot, kind) {
  if (snapshot.spectating) return '观战中无法使用技能';
  if (snapshot.state !== 'playing') return '请先开始或继续游戏';
  const ability = snapshot[kind];
  if (!ability) return '技能暂不可用';
  if (kind === 'split' && ability.count >= ability.maxCells) return `分身已满（${ability.maxCells} 个）`;
  if (kind === 'spore' && ability.count >= ability.maxCount) return '场上孢子已满，请稍候';
  if (!ability.affordable) return kind === 'split' ? '单个分身至少需要 72 m' : '单个分身至少需要 48 m';
  if (ability.cooldown > 0) return `冷却中 · ${ability.cooldown.toFixed(1)} 秒`;
  return '';
}

/** 只预览新分身的短时弹射方向和半质量；不预测碰撞或承诺能吞噬目标。 */
export function splitProjection(snapshot, aim, seconds = .35) {
  if (!snapshot.split?.ready || snapshot.state !== 'playing' || snapshot.spectating) return [];
  const center = snapshot.player;
  let dx = aim?.target ? aim.target.x - center.x : aim?.x ?? 0;
  let dy = aim?.target ? aim.target.y - center.y : aim?.y ?? 0;
  if (Math.hypot(dx, dy) < .05) { dx = center.vx || 0; dy = center.vy || 0; }
  const length = Math.hypot(dx, dy);
  if (length < .05) return [];
  dx /= length; dy /= length;
  const launch = CONFIG.split.launchSpeed / CONFIG.split.launchDecay * (1 - Math.exp(-CONFIG.split.launchDecay * seconds));
  return snapshot.playerCells.filter(cell => cell.alive && cell.mass >= CONFIG.split.minimumMass)
    .sort((a, b) => b.mass - a.mass).slice(0, snapshot.split.maxCells - snapshot.playerCells.length)
    .map(cell => {
      const radius = Math.sqrt(cell.mass / 2) * CONFIG.rules.radiusScale;
      const distance = radius * .65 + launch;
      return { from: cell, mass: cell.mass / 2, radius,
        x: clamp(cell.x + dx * distance, radius, snapshot.bounds.width - radius),
        y: clamp(cell.y + dy * distance, radius, snapshot.bounds.height - radius) };
    });
}

/** 小窗口的实际帧间隔和 Canvas 绘制耗时；跳过暂停和后台长帧，按需计算 P95。 */
export class FrameMetrics {
  constructor() { this.frames = []; this.costs = []; }
  observe(frameMs, drawMs, active) {
    if (!active || !Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 250 || !Number.isFinite(drawMs) || drawMs < 0) return;
    this.frames.push(frameMs); this.costs.push(drawMs);
    if (this.frames.length > 120) { this.frames.shift(); this.costs.shift(); }
  }
  snapshot() {
    if (!this.frames.length) return null;
    const sorted = [...this.costs].sort((a, b) => a - b);
    return { fps: 1000 / (this.frames.reduce((a, b) => a + b, 0) / this.frames.length),
      drawP95: sorted[Math.max(0, Math.ceil(sorted.length * .95) - 1)], samples: sorted.length };
  }
}
