/** 集中调整玩法参数。质量决定面积：半径 ∝ √质量，速度 ∝ 质量的负四次方根。 */
export const CONFIG = Object.freeze({
  world: { width: 3200, height: 2200 },
  player: { initialMass: 36, baseSpeed: 220, minimumSpeed: 65, protectionSeconds: 3 },
  food: { count: 560, mass: 1, radius: 3.3, refillInterval: 0.3 },
  bots: { count: 13, respawnDelay: 4, thinkInterval: 0.24 },
  survival: { duration: 300, initialLives: 3, respawnProtection: 3 },
  difficulty: { refreshInterval: 8, spawnPadding: 100, maxReferenceMass: 2000 },
  // 保留旧配置字段供旧存档/测试读取，但 Shift 不再触发冲刺。
  sprint: { multiplier: 1.85, duration: 1.2, cooldown: 4.5, costRatio: 0.07, minimumMass: 24 },
  // 吐孢子：E 键一次吐出一个小质量球，消耗自身质量但不会直接增加得分。
  spore: { mass: 8, minimumMass: 48, cooldown: 0.45, speed: 560, decay: 1.8, lifetime: 5, maxCount: 80 },
  // 刺球：碰撞后会把球群拆散，并损失少量质量。
  spikes: { count: 10, radius: 58, minimumMass: 72, lossRatio: 0.08, cooldown: 1.25, pushSpeed: 300 },
  split: {
    maxCells: 8, minimumMass: 72, cooldown: 0.75, mergeDelay: 10,
    launchSpeed: 620, launchDecay: 5, regroupSpeed: 260,
    hunterGroups: 2, hunterMaxCells: 2, hunterCooldown: 14,
  },
  milestones: [300, 800, 1500, 3000, 5000, 8000],
  rules: { radiusScale: 3, eatMassRatio: 1.28, overlapFactor: 0.35 },
  simulation: { step: 1 / 60, maxFrameTime: 0.1 },
  music: { tempo: 76, defaultVolume: 0.3, outputGain: 0.65, lookAhead: 0.16, timerInterval: 50 },
  effects: { volume: 0.28, maxVoices: 12, globalInterval: 0.045, foodInterval: 0.14 },
  hotspots: { count: 2, radius: 190, duration: 45, foodRatio: 0.36, separation: 650 },
  feedback: { skillReadySeconds: 0.9, hotspotWarningSeconds: 5, hotspotHighlightSeconds: 3 },
  labels: { detailZoom: 0.55, detailDistance: 360 },
  spatial: { cellSize: 180 },
});

export const BOT_NAMES = ["小橘", "薄荷", "漫游者", "布丁", "小行星", "云朵", "蓝莓", "泡泡", "松果", "晚风", "桃子", "奶盖", "路过的球"];
export const BOT_COLORS = ["#dd998d", "#b2a4dc", "#e0bd80", "#88adc9", "#b5c789", "#d49fb9"];
export const FOOD_COLORS = ["#b4d3ac", "#d7bc77", "#91accd", "#bd9abb", "#ce9185", "#82b8ac"];
