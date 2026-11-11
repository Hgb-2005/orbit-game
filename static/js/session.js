import { World } from "./core/world.js";
import { getLeaderboard } from "./core/leaderboard.js";
import { createSeededRandom } from "./core/random.js";
import { ChallengeTracker } from "./challenges/daily-run.js";
import { DEFAULT_MAP } from "./maps/map-schema.js";

/** 练习与每日挑战使用独立记录；联机成绩仅由服务器保存。 */
export const isRankedRound = snapshot =>
  !snapshot.network && !["practice", "daily"].includes(snapshot.mode);

/**
 * 会话是 UI 与规则引擎之间的边界。
 * 多人版可新增 RemoteSession，保留 start / pause / step / getSnapshot 接口，
 * 在 step 中发送输入，在 getSnapshot 中读取服务器状态。
 */
export class LocalSession {
  constructor() {
    this.world = new World();
    this.state = "ready";
    this.roundId = '';
    this.simulationMs = 0;
    this.challenge = null;
  }

  start(viewSize, mode = "classic", drill = "split", options = {}) {
    this.roundId = `local-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;
    const challenge = mode === "daily" ? options.challenge : null;
    if (challenge && (challenge.mode !== "daily" || !challenge.seed)) {
      throw new TypeError("每日挑战缺少有效契约");
    }
    this.challenge = challenge ? new ChallengeTracker(challenge) : null;
    this.world.reset(viewSize, mode, drill, {
      ...options,
      // 每日题面必须共享同一张地图；即使调用方误传了自定义地图也回退到标准场。
      map: challenge ? DEFAULT_MAP : options.map,
      random: challenge ? createSeededRandom(challenge.seed) : undefined,
    });
    this.state = "playing";
    this.simulationMs = 0;
  }

  pause() {
    if (this.state === "playing") {
      this.state = "paused";
      this.world.sprint.wasPressed = false;
      this.world.split.wasPressed = false;
      this.world.sporeWasPressed = false;
    }
  }

  resume() {
    if (this.state === "paused") this.state = "playing";
  }

  step(dt, input) {
    if (this.state !== "playing") return [];
    const started = globalThis.performance?.now?.() ?? Date.now();
    this.world.update(dt, input);
    this.simulationMs = (globalThis.performance?.now?.() ?? Date.now()) - started;
    if (this.world.gameOver) this.state = "gameover";
    if (this.challenge) this.challenge.update(this.baseSnapshot(), this.world.events, dt);
    return this.world.events;
  }

  baseSnapshot() {
    const world = this.world;
    const cells = [...world.playerCells, ...world.bots];
    const survival = world.survival?.getSnapshot(cells, world.elapsed) ?? null;
    return {
      mode: world.mode, survival, result: world.result,
      map: world.map, obstacles: world.obstacles,
      stats: world.stats.snapshot(this.state === 'gameover'), practice: world.practice?.snapshot() ?? null, regrouping: world.regrouping,
      state: this.state, bounds: world.bounds, player: world.playerGroup,
      playerCells: world.playerCells,
       bots: world.bots, foods: world.foods, spores: world.spores, spikes: world.spikes, score: world.score,
      elapsed: world.elapsed, eatenBalls: world.eatenBalls,
      protectionRemaining: world.protectionRemaining, killer: world.killer,
       sprint: world.sprint.getSnapshot(world.playerCells), split: world.split.getSnapshot(world.playerCells), spore: world.getSporeSnapshot(), stage: world.stage,
      difficulty: world.difficulty, peakMass: world.peakMass,
      leaderboard: survival ? { kind: "survival", entries: survival.standings.slice(0, 5),
        player: survival.player, total: survival.total, alive: survival.active } :
        getLeaderboard(cells),
      metrics: { simulationMs: this.simulationMs, collisionMs: world.lastCollisionMs || 0 },
      hotspots: world.hotspots.getSnapshot(),
      items: world.itemSystem.snapshot("player"),
    };
  }

  getSnapshot() {
    return {
      ...this.baseSnapshot(),
      challenge: this.challenge?.snapshot() ?? null,
    };
  }
}
