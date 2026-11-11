/**
 * 外观目录是客户端与网络层共用的唯一白名单。
 * 这里只保存展示元数据；碰撞、质量和技能参数不应依赖皮肤。
 */
const freezeSkin = skin => Object.freeze({ ...skin });

export const BALL_SKINS = Object.freeze([
  freezeSkin({ id: "mint-orbit", name: "薄荷轨道", description: "清爽光环 · 默认", accent: "#b4efcc",
    secondary: "#f0cf8e", motif: "orbit" }),
  freezeSkin({ id: "ocean-tide", name: "海潮", description: "流动波纹 · 冷色", accent: "#78bfe3",
    secondary: "#b8f0e6", motif: "waves" }),
  freezeSkin({ id: "ember-sun", name: "余烬日轮", description: "暖色光冠 · 高对比", accent: "#e69673",
    secondary: "#f3cf7d", motif: "sun" }),
  freezeSkin({ id: "violet-nebula", name: "紫罗兰星云", description: "星尘团块 · 深空", accent: "#ae9be2",
    secondary: "#e7a6c8", motif: "nebula" }),
  freezeSkin({ id: "pixel-grid", name: "像素矩阵", description: "霓虹方格 · 数字感", accent: "#79d4c0",
    secondary: "#81a9e4", motif: "pixel" }),
  freezeSkin({ id: "citrus-stripes", name: "柑橘斜纹", description: "明亮条纹 · 轻快", accent: "#e7be61",
    secondary: "#9fcf82", motif: "citrus" }),
]);

export const SPORE_SKINS = Object.freeze([
  freezeSkin({ id: "dew-drop", name: "晨露", description: "水珠高光 · 默认", accent: "#b8eee0",
    secondary: "#ffffff", motif: "dew" }),
  freezeSkin({ id: "comet-tail", name: "彗尾", description: "按飞行方向拖曳", accent: "#8fc8ed",
    secondary: "#e0f5ff", motif: "comet" }),
  freezeSkin({ id: "flower-bloom", name: "花瓣", description: "四瓣花形", accent: "#e9abc2",
    secondary: "#f5dc9d", motif: "flower" }),
  freezeSkin({ id: "spark-crystal", name: "晶簇", description: "锋利交叉闪光", accent: "#b4a8ec",
    secondary: "#f4e8ff", motif: "crystal" }),
  freezeSkin({ id: "orbit-ring", name: "微行星", description: "倾斜轨道环", accent: "#e5c573",
    secondary: "#d5f2e8", motif: "orbit" }),
  freezeSkin({ id: "zigzag-seed", name: "锯齿种子", description: "轻快折线标记", accent: "#9ed58e",
    secondary: "#f0b778", motif: "zigzag" }),
]);

export const DEFAULT_APPEARANCE = Object.freeze({
  ballSkin: "mint-orbit",
  sporeSkin: "dew-drop",
});

export const APPEARANCE_STORAGE_KEYS = Object.freeze({
  ballSkin: "orbit.ballSkin",
  sporeSkin: "orbit.sporeSkin",
});

export const BALL_SKIN_IDS = Object.freeze(BALL_SKINS.map(skin => skin.id));
export const SPORE_SKIN_IDS = Object.freeze(SPORE_SKINS.map(skin => skin.id));
const ballSkinSet = new Set(BALL_SKIN_IDS);
const sporeSkinSet = new Set(SPORE_SKIN_IDS);

export function normalizeBallSkin(value) {
  return ballSkinSet.has(value) ? value : DEFAULT_APPEARANCE.ballSkin;
}

export function normalizeSporeSkin(value) {
  return sporeSkinSet.has(value) ? value : DEFAULT_APPEARANCE.sporeSkin;
}

/** 单个字段失效时分别回退，避免一个未知值清空另一项已选外观。 */
export function normalizeAppearance(value = {}) {
  return {
    ballSkin: normalizeBallSkin(value?.ballSkin),
    sporeSkin: normalizeSporeSkin(value?.sporeSkin),
  };
}

export function getBallSkin(id) {
  return BALL_SKINS.find(skin => skin.id === normalizeBallSkin(id));
}

export function getSporeSkin(id) {
  return SPORE_SKINS.find(skin => skin.id === normalizeSporeSkin(id));
}

/** localStorage 可能被隐私模式、损坏数据或旧版本字段阻断，读取必须无副作用。 */
export function readAppearance(storage) {
  if (!storage) return { ...DEFAULT_APPEARANCE };
  try {
    return normalizeAppearance({
      ballSkin: storage.getItem(APPEARANCE_STORAGE_KEYS.ballSkin),
      sporeSkin: storage.getItem(APPEARANCE_STORAGE_KEYS.sporeSkin),
    });
  } catch {
    return { ...DEFAULT_APPEARANCE };
  }
}

export function writeAppearance(storage, value) {
  const normalized = normalizeAppearance(value);
  if (!storage) return normalized;
  try {
    storage.setItem(APPEARANCE_STORAGE_KEYS.ballSkin, normalized.ballSkin);
    storage.setItem(APPEARANCE_STORAGE_KEYS.sporeSkin, normalized.sporeSkin);
  } catch {
    // 存储权限只影响下次打开时的默认选择，不影响本次游戏。
  }
  return normalized;
}
