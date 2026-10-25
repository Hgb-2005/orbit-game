import { World } from "./core/world.js";
import { getLeaderboard } from "./core/leaderboard.js";

/**
 * 会话是 UI 与规则引擎之间的边界。
 * 多人版可新增 RemoteSession，保留 start / pause / step / getSnapshot 接口，
 * 在 step 中发送输入，在 getSnapshot 中读取服务器状态。
 */
export class LocalSession {
  constructor() {
    this.world = new World();
    this.state = "ready";
  }

  start(viewSize, mode = "classic") {
    this.world.reset(viewSize, mode);
    this.state = "playing";
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
    this.world.update(dt, input);
    if (this.world.gameOver) this.state = "gameover";
    return this.world.events;
  }

  getSnapshot() {
    const world = this.world;
    const cells = [...world.playerCells, ...world.bots];
    const survival = world.survival?.getSnapshot(cells, world.elapsed) ?? null;
    return {
      mode: world.mode, survival, result: world.result,
      state: this.state, bounds: world.bounds, player: world.playerGroup,
      playerCells: world.playerCells,
       bots: world.bots, foods: world.foods, spores: world.spores, spikes: world.spikes, score: world.score,
      elapsed: world.elapsed, eatenBalls: world.eatenBalls,
      protectionRemaining: world.protectionRemaining, killer: world.killer,
       sprint: world.sprint.getSnapshot(world.playerCells), split: world.split.getSnapshot(world.playerCells), spore: world.getSporeSnapshot(), stage: world.stage,
      difficulty: world.difficulty, peakMass: world.peakMass,
      leaderboard: survival ? { kind: "survival", entries: survival.standings.slice(0, 5),
        player: survival.player, total: survival.total } : getLeaderboard(cells),
      hotspots: world.hotspots.getSnapshot(),
    };
  }
}
