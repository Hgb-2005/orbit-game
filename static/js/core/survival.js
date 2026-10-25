import { CONFIG } from "../config.js";

/** 生命属于控制者而非分身；身份、命数和战绩在复活时保留，方便以后由服务端管理。 */
export class SurvivalRound {
  constructor() {
    this.duration = CONFIG.survival.duration;
    this.roster = new Map();
  }

  register(ball) {
    this.roster.set(ball.ownerId, {
      ownerId: ball.ownerId, name: ball.name, color: ball.color, isPlayer: ball.isPlayer,
      role: ball.role, initialMass: ball.mass, lives: CONFIG.survival.initialLives,
      kills: 0, deaths: 0, protectedUntil: CONFIG.survival.respawnProtection,
    });
  }

  protection(ownerId, elapsed) {
    return Math.max(0, (this.roster.get(ownerId)?.protectedUntil ?? 0) - elapsed);
  }

  /** 仅在最后一个分身被吃时调用，先记账，再由世界统一生成新球，避免同帧反复扣命。 */
  recordDeath(victimId, killerId, elapsed) {
    const victim = this.roster.get(victimId);
    const killer = this.roster.get(killerId);
    if (!victim || victim.lives <= 0 || victimId === killerId) return null;
    victim.lives--;
    victim.deaths++;
    if (killer && killer.lives > 0) {
      killer.lives++;
      killer.kills++;
    }
    victim.protectedUntil = victim.lives > 0 ? elapsed + CONFIG.survival.respawnProtection : 0;
    return victim;
  }

  standings(cells) {
    const totals = new Map();
    for (const cell of cells) {
      if (!cell.alive) continue;
      const total = totals.get(cell.ownerId) ?? { mass: 0, cells: 0 };
      total.mass += cell.mass;
      total.cells++;
      totals.set(cell.ownerId, total);
    }
    const ranked = [...this.roster.values()].map(owner => ({ ...owner,
      ...(totals.get(owner.ownerId) ?? { mass: 0, cells: 0 }), eliminated: owner.lives <= 0,
    })).sort((a, b) => b.lives - a.lives || b.kills - a.kills || b.mass - a.mass || a.ownerId.localeCompare(b.ownerId));
    // 三项均相同则并列名次，不用名字或 ID 裁定胜负。
    return ranked.map((entry, index) => {
      const previous = ranked[index - 1];
      entry.rank = previous && previous.lives === entry.lives && previous.kills === entry.kills && previous.mass === entry.mass
        ? previous.rank : index + 1;
      return entry;
    });
  }

  getSnapshot(cells, elapsed) {
    const standings = this.standings(cells);
    return {
      duration: this.duration, remaining: Math.max(0, this.duration - elapsed),
      player: standings.find(owner => owner.isPlayer),
      active: standings.filter(owner => !owner.eliminated).length, total: this.roster.size,
      standings,
      protectionByOwner: Object.fromEntries([...this.roster.keys()].map(id => [id, this.protection(id, elapsed)])),
    };
  }
}

/** 随机候选加固定网格兜底，取离其他球边缘最远的位置；拥挤时仍能立即复活。 */
export function findRespawnPosition(bounds, mass, cells, random) {
  const radius = Math.sqrt(mass) * CONFIG.rules.radiusScale;
  const candidates = [];
  for (let i = 0; i < 48; i++) candidates.push({ x: random(), y: random() });
  for (let y = 0; y < 7; y++) {
    for (let x = 0; x < 10; x++) candidates.push({ x: (x + 0.5) / 10, y: (y + 0.5) / 7 });
  }
  let best = null;
  let bestGap = -Infinity;
  for (const point of candidates) {
    const candidate = {
      x: radius + point.x * (bounds.width - radius * 2),
      y: radius + point.y * (bounds.height - radius * 2),
    };
    const gap = cells.reduce((nearest, cell) => !cell.alive ? nearest :
      Math.min(nearest, Math.hypot(candidate.x - cell.x, candidate.y - cell.y) - cell.radius - radius), Infinity);
    if (best === null || gap > bestGap) { best = candidate; bestGap = gap; }
    if (gap > 400) return candidate;
  }
  return best;
}
