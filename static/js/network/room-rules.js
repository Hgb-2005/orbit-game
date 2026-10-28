/** 界面预设不替代服务端校验；发包始终使用完整字段，避免只改一项时丢失其他设置。 */
export const ROOM_DEFAULTS = Object.freeze({ mode: "survival", duration: 300, botCount: -1,
  botDifficulty: "standard", foodDensity: "normal", initialMass: 36 });
export const ROOM_PRESETS = Object.freeze({
  standard: { duration: 300, botCount: -1, botDifficulty: "standard", foodDensity: "normal", initialMass: 36 },
  casual: { duration: 300, botCount: -1, botDifficulty: "casual", foodDensity: "rich", initialMass: 72 },
  quick: { duration: 180, botCount: -1, botDifficulty: "challenge", foodDensity: "rich", initialMass: 144 },
});
export const RULE_FIELDS = { mode: "mode", duration: "duration", botCount: "bot-count", botDifficulty: "bot-difficulty",
  foodDensity: "food-density", initialMass: "initial-mass" };
export const MODE_NAMES = Object.freeze({ survival: '生存乱斗', teams: '2v2 团队', shrink: '缩圈乱斗' });
export const isStandardRules = rules => {
  const value = { ...ROOM_DEFAULTS, ...rules };
  return value.mode !== 'shrink' && ["botCount", "botDifficulty", "foodDensity", "initialMass"].every(key => value[key] === ROOM_DEFAULTS[key]);
};
export function presetName(rules) {
  return Object.keys(ROOM_PRESETS).find(id => Object.entries(ROOM_PRESETS[id]).every(([key, value]) => rules[key] === value)) ?? "custom";
}
export function describeRules(rules, humans = 1) {
  const r = { ...ROOM_DEFAULTS, ...rules };
  const ai = r.botCount === -1 ? Math.max(0, 4 - humans) : Math.min(r.botCount, Math.max(0, 4 - humans));
  return `${MODE_NAMES[r.mode]} · ${r.duration / 60} 分钟 · 人机 ${ai} 名（${{ casual: "休闲", standard: "标准", challenge: "挑战" }[r.botDifficulty]}） · ${r.initialMass} m 开局 · ${{ sparse: "稀疏", normal: "标准", rich: "密集" }[r.foodDensity]}食物。${isStandardRules(r) ? "计入标准最高分。" : "自定义局，按相同规则单独记录最高分。"}被吃后仍以 36 m 复活。${r.mode === 'shrink' ? '三次缩圈，提前 5 秒预告；全体分身在圈外连续 8 秒扣一命，复活在圈内。' : ''}`;
}
