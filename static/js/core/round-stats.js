/** 只累计已发生的规则事件；分裂一次生成多个球，仍只算一次主动操作。 */
const COUNTERS = { food: "foods", eat: "cellsEaten", spore: "sporesEmitted", "spore-eat": "sporesEaten",
  "spike-feed": "spikesFed", "spike-launch": "spikesLaunched", merge: "merges", spike: "spikeHits", celllost: "cellsLost" };

export class RoundStats {
  constructor() {
    this.values = { foods: 0, cellsEaten: 0, sporesEmitted: 0, sporesEaten: 0, spikesFed: 0,
      spikesLaunched: 0, splits: 0, merges: 0, spikeHits: 0, cellsLost: 0, maxCells: 1, peakMass: 0, activeSeconds: 0 };
    this.timeline = [];
    this.deathLog = [];
    this.sampleInterval = 2;
  }

  sample(elapsed, cells, force = false) {
    const point = [Number(elapsed.toFixed(3)), Math.round(cells.filter(c => c.alive).reduce((s, c) => s + c.mass, 0) * 10) / 10];
    const last = this.timeline.at(-1);
    if (last && last[0] === point[0] && last[1] === point[1]) return;
    if (!force && last && elapsed - last[0] < this.sampleInterval) return;
    this.timeline.push(point);
    if (this.timeline.length > 121) {
      this.timeline = this.timeline.filter((_, i) => i % 2 === 0).concat([this.timeline.at(-1)]);
      this.sampleInterval *= 2;
    }
  }

  death(elapsed, cause, killer = "", mass = 0) {
    this.deathLog.push({ time: Number(elapsed.toFixed(3)), cause, killer, mass: Math.round(mass * 10) / 10 });
    this.deathLog = this.deathLog.slice(-40);
    this.sample(elapsed, [], true);
  }

  record(events, ownerId = "player") {
    let split = false;
    for (const event of events) {
      if (event.actorId !== undefined && event.actorId !== ownerId) continue;
      if (event.ownerId && event.ownerId !== ownerId) continue;
      // 喂刺事件全场可见，但只有孢子的拥有者获得自己的统计。
      if (["spike-feed", "spike-launch"].includes(event.type) && event.actorId !== ownerId) continue;
      if (event.type === "split") split = true;
      const key = COUNTERS[event.type];
      if (key) this.values[key]++;
    }
    if (split) this.values.splits++;
  }

  observe(cells) {
    const live = cells.filter(cell => cell.alive);
    this.values.maxCells = Math.max(this.values.maxCells, live.length);
    this.values.peakMass = Math.max(this.values.peakMass, live.reduce((total, cell) => total + cell.mass, 0));
  }

  snapshot(recap = false) { return { ...this.values, ...(recap ? {
    massTimeline: this.timeline.map(p => [...p]), deathLog: this.deathLog.map(d => ({ ...d })),
  } : {}) }; }
  advance(dt) { this.values.activeSeconds += dt; }
}
