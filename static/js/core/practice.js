import { CONFIG } from "../config.js";
import { createBall, growBall } from "./entities.js";

export const PRACTICE_DRILLS = Object.freeze([
  { id: "split", title: "分裂吞噬", description: "鼠标指向蓝色靶球，右键 / Q 分身并吞噬它。", goal: "分裂一次并吞噬靶球" },
  { id: "feed", title: "喂刺反击", description: "开局面对右侧刺球，按住 E 原地连吐；也可移动调整角度，喂满 5 颗发射反击刺。", goal: "喂出一颗反击刺" },
  { id: "regroup", title: "聚拢合体", description: "按住 C 或右侧聚拢按钮收拢四个分身，等待 10 秒合体冷却后自动合体。", goal: "聚拢至少半秒，再合成单球" },
]);

/** 练习只布置场景、补给和检查目标，技能与碰撞继续使用真实 World 规则。 */
export class PracticeCourse {
  constructor(id = "split") {
    this.drill = PRACTICE_DRILLS.find(drill => drill.id === id) || PRACTICE_DRILLS[0];
    this.complete = false;
    this.completedAt = null;
    this.regroupSeconds = 0;
    this.refills = 0;
  }

  setup(world) {
    world.foods = []; world.bots = []; world.spores = []; world.spikes = [];
    world.hotspots.zones = [];
    const center = { x: world.bounds.width / 2, y: world.bounds.height / 2 };
    const make = (id, mass, dx, dy) => createBall({ id, mass, x: center.x + dx, y: center.y + dy,
      isPlayer: true, color: "#b4efcc", name: "你" });
    world.playerCells = [make("player", this.drill.id === "split" ? 144 : 240, -150, 0)];
    world.lastPlayer = world.player;
    if (this.drill.id === "split") this.spawnTarget(world);
    if (this.drill.id === "feed") {
      world.spikes = [{ id: "practice-spike", x: center.x + 60, y: center.y, radius: CONFIG.spikes.radius,
        color: "#72c98e", charge: 0 }];
      const dummy = createBall({ id: "practice-obstacle", mass: 180, x: center.x + 330, y: center.y,
        name: "反击靶", color: "#dd998d" });
      dummy.thinkTimer = Infinity; dummy.role = "practice";
      world.bots = [dummy];
    }
    if (this.drill.id === "regroup") {
      this.setupRegroup(world);
    }
    world.peakMass = world.playerGroup.mass;
    world.stats.observe(world.playerCells);
    world.spikeGrid.build(world.spikes);
  }

  setupRegroup(world) {
    world.playerCells = [[-135, -100], [135, -100], [-135, 100], [135, 100]].map(([dx, dy]) => {
      const cell = createBall({ id: `practice-cell-${world.nextId++}`, mass: 72,
        x: world.bounds.width / 2 + dx, y: world.bounds.height / 2 + dy,
        isPlayer: true, color: "#b4efcc", name: "你" });
      cell.mergeRemaining = CONFIG.split.mergeDelay;
      return cell;
    });
    world.lastPlayer = world.player;
  }

  spawnTarget(world) {
    const target = createBall({ id: `practice-target-${world.nextId++}`, mass: 44,
      x: world.bounds.width / 2 + 120, y: world.bounds.height / 2, name: "吞噬靶", color: "#88adc9" });
    target.thinkTimer = Infinity; target.role = "practice";
    world.bots.push(target);
  }

  update(world, dt, input) {
    if (this.complete) return;
    if (input.regroup && world.playerCells.length > 1) this.regroupSeconds += dt;
    const stats = world.stats.snapshot();
    const success = this.drill.id === "split" ? stats.splits > 0 && stats.cellsEaten > 0 :
      this.drill.id === "feed" ? stats.spikesLaunched > 0 : this.regroupSeconds >= .5 && world.playerCells.length === 1;
    if (success) {
      this.complete = true; this.completedAt = world.elapsed;
      world.events.push({ type: "practice-complete", title: this.drill.title });
      return;
    }
    // 失误后仍能继续练习；补给只属于练习场，不产生分数或训练完成事件。
    if (this.drill.id === "split" && !world.bots.length) this.spawnTarget(world);
    if (this.drill.id === "regroup" && world.playerCells.length === 1 && this.regroupSeconds < .5) {
      this.setupRegroup(world); this.refills++;
    }
    const source = world.player;
    if (source.mass < (this.drill.id === "split" ? 72 : 48)) {
      growBall(source, (this.drill.id === "split" ? 144 : 240) - source.mass);
      this.refills++;
    }
  }

  snapshot() {
    return { ...this.drill, complete: this.complete, completedAt: this.completedAt,
      regroupSeconds: this.regroupSeconds, refills: this.refills,
      nextId: PRACTICE_DRILLS[(PRACTICE_DRILLS.indexOf(this.drill) + 1) % PRACTICE_DRILLS.length].id };
  }
}
