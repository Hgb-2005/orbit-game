import { CONFIG } from "../config.js";
import { clamp } from "./entities.js";

const STAGE_NAMES = ["初生微光", "星尘旅人", "逐光行者", "星河漫游", "引力主宰", "璀璨星辰", "无垠宇宙"];
const DIFFICULTY_NAMES = ["舒缓探索", "渐入佳境", "暗流涌动", "强者云集", "巅峰对局", "极限生存"];

/** 用累计得分推进阶段，技能造成的质量变化不会倒退阶段或重复发奖。 */
export function getStage(score) {
  let index = 0;
  let previousTarget = 0;
  let target = CONFIG.milestones[0];
  while (score >= target) {
    previousTarget = target;
    index++;
    target = CONFIG.milestones[index] ?? Math.ceil(target * 1.5 / 100) * 100;
  }
  return {
    index, title: STAGE_NAMES[Math.min(index, STAGE_NAMES.length - 1)],
    previousTarget, target, progress: clamp((score - previousTarget) / (target - previousTarget), 0, 1),
  };
}

/** 难度随阶段和生存时间缓慢提高；规模参考本局最大质量，避免技能损耗使难度来回跳动。 */
export function getDifficulty(score, peakMass, elapsed) {
  const level = Math.min(5, Math.max(getStage(score).index, Math.floor(elapsed / 180)));
  return {
    level, title: DIFFICULTY_NAMES[level],
    referenceMass: clamp(peakMass, CONFIG.player.initialMass, CONFIG.difficulty.maxReferenceMass),
    pressure: 1 + level * 0.035,
  };
}

export const BOT_ROLES = {
  forager: { label: "觅食者", quota: 5, minRatio: 0.38, maxRatio: 0.68, chaseRange: 210 },
  rival: { label: "游猎者", quota: 5, minRatio: 0.85, maxRatio: 1.15, chaseRange: 320 },
  hunter: { label: "追猎者", quota: 3, minRatio: 1.6, maxRatio: 2.1, chaseRange: 450 },
};

export function roleForIndex(index) {
  return index < 5 ? "forager" : index < 10 ? "rival" : "hunter";
}

/** 球体（含缓冲距离）完全离开视野，才允许在那里出生或被替换。 */
export function outsideView(ball, view, padding = CONFIG.difficulty.spawnPadding) {
  return ball.x + ball.radius + padding < view.left || ball.x - ball.radius - padding > view.right ||
    ball.y + ball.radius + padding < view.top || ball.y - ball.radius - padding > view.bottom;
}
