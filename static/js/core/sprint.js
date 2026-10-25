import { CONFIG } from "../config.js";
import { growBall } from "./entities.js";

/** 冲刺状态只随模拟时间推进；暂停时不会偷偷消耗持续时间或冷却时间。 */
export class Sprint {
  constructor() {
    this.remaining = 0;
    this.cooldown = 0;
    this.wasPressed = false;
    this.direction = { x: 0, y: 0 };
    this.started = false;
  }

  update(dt, input, playerOrCells) {
    const cells = Array.isArray(playerOrCells) ? playerOrCells : [playerOrCells];
    this.started = false;
    // 跨过冲刺结束点的那一帧，只把多余的时间计入冷却。
    const activeTime = Math.min(dt, this.remaining);
    this.remaining = Math.max(0, this.remaining - dt);
    this.cooldown = Math.max(0, this.cooldown - (dt - activeTime));

    const pressed = Boolean(input.sprint);
    const inputLength = Math.hypot(input.x, input.y);
    const moving = cells.find(cell => Math.hypot(cell.vx, cell.vy) > 5);
    // 所有分身按同一比例扣质量，总消耗仍为 7%；最小分身也不能低于门槛。
    const affordable = cells.length > 0 && cells.every(cell => cell.mass - this.costFor(cell) >= CONFIG.sprint.minimumMass);
    if (pressed && !this.wasPressed && this.remaining === 0 && this.cooldown === 0 &&
        affordable && (inputLength > 0.05 || moving)) {
      for (const cell of cells) growBall(cell, -this.costFor(cell));
      const direction = inputLength > 0.05 ? input : { x: moving.vx, y: moving.vy };
      const length = Math.hypot(direction.x, direction.y);
      this.direction = { x: direction.x / length, y: direction.y / length };
      this.remaining = CONFIG.sprint.duration;
      this.cooldown = CONFIG.sprint.cooldown;
      this.started = true;
    }
    this.wasPressed = pressed;
    // 可在冲刺中转向；离开画布/抬起触屏时沿最后方向完成短冲刺。
    if (this.remaining > 0 && inputLength > 0.05) {
      this.direction = { x: input.x / inputLength, y: input.y / inputLength };
    }
    return this.remaining > 0 ? this.direction : input;
  }

  costFor(player) {
    return Math.max(1, player.mass * CONFIG.sprint.costRatio);
  }

  getSnapshot(playerOrCells) {
    const cells = Array.isArray(playerOrCells) ? playerOrCells : [playerOrCells];
    const active = this.remaining > 0;
    const affordable = cells.length > 0 && cells.every(cell => cell.mass - this.costFor(cell) >= CONFIG.sprint.minimumMass);
    return {
      active, remaining: this.remaining, cooldown: this.cooldown,
      ready: !active && this.cooldown === 0 && affordable, affordable,
      multiplier: active ? CONFIG.sprint.multiplier : 1,
      progress: active ? this.remaining / CONFIG.sprint.duration : 1 - this.cooldown / CONFIG.sprint.cooldown,
    };
  }
}
