const STORAGE_KEY = "orbit.visual.v1";
const SCHEMA_VERSION = 1;
export const MAX_CUSTOM_SKIN_FILE_BYTES = 2 * 1024 * 1024;
// Base64 会把原图放大约三分之一，校验时按编码后的 data URL 留出余量。
const MAX_CUSTOM_SKIN_DATA_URL_LENGTH = 2_800_000;

export const BACKGROUND_OPTIONS = Object.freeze([
  { id: "dark", label: "纯色深空" },
  { id: "stars", label: "星空粒子" },
  { id: "ring", label: "星环" },
  { id: "galaxy", label: "银河" },
  { id: "mountain", label: "山巅" },
  { id: "blackhole", label: "黑洞" },
]);

export const SKIN_OPTIONS = Object.freeze([
  { id: "solid", label: "纯色" },
  { id: "aurora", label: "极光渐变" },
  { id: "nebula", label: "流体星云" },
  { id: "ocean", label: "深海流光" },
  { id: "custom", label: "自定义贴图" },
]);

export const RENDERER_OPTIONS = Object.freeze([
  { id: "auto", label: "自动 WebGL" },
  { id: "webgl", label: "WebGL 流体" },
  { id: "canvas", label: "Canvas 兼容" },
]);

export const SKIN_STYLES = Object.freeze({
  solid: { hueShift: 0, saturation: 0, flowScale: 2.4, accent: [0.58, 0.93, 0.73] },
  aurora: { hueShift: 0.08, saturation: 0.22, flowScale: 3.4, accent: [0.44, 0.94, 0.77] },
  nebula: { hueShift: -0.09, saturation: 0.34, flowScale: 4.1, accent: [0.66, 0.52, 1] },
  ocean: { hueShift: 0.05, saturation: 0.18, flowScale: 3.1, accent: [0.32, 0.67, 1] },
});

const DEFAULTS = Object.freeze({
  schemaVersion: SCHEMA_VERSION,
  renderer: "auto",
  fluid: true,
  background: "stars",
  skin: "solid",
  customSkin: "",
  particles: 72,
  trails: 64,
  distortion: 48,
  glow: true,
  audioReactive: false,
  microphone: false,
});

const LIMITS = Object.freeze({
  particles: [0, 100],
  trails: [0, 100],
  distortion: [0, 100],
});

function clampNumber(value, fallback, [minimum, maximum]) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.max(minimum, Math.min(maximum, Math.round(number)));
}

function oneOf(value, values, fallback) {
  return values.includes(value) ? value : fallback;
}

export function normalizeVisualSettings(input = {}) {
  const source = input && typeof input === "object" ? input : {};
  const customSkin = typeof source.customSkin === "string" &&
    /^data:image\/(?:png|jpeg|webp);base64,/i.test(source.customSkin) &&
    source.customSkin.length <= MAX_CUSTOM_SKIN_DATA_URL_LENGTH ? source.customSkin : "";
  return {
    schemaVersion: SCHEMA_VERSION,
    renderer: oneOf(source.renderer, RENDERER_OPTIONS.map(option => option.id), DEFAULTS.renderer),
    fluid: source.fluid === undefined ? DEFAULTS.fluid : Boolean(source.fluid),
    background: oneOf(source.background, BACKGROUND_OPTIONS.map(option => option.id), DEFAULTS.background),
    skin: oneOf(source.skin, SKIN_OPTIONS.map(option => option.id), DEFAULTS.skin),
    customSkin,
    particles: clampNumber(source.particles, DEFAULTS.particles, LIMITS.particles),
    trails: clampNumber(source.trails, DEFAULTS.trails, LIMITS.trails),
    distortion: clampNumber(source.distortion, DEFAULTS.distortion, LIMITS.distortion),
    glow: source.glow === undefined ? DEFAULTS.glow : Boolean(source.glow),
    audioReactive: source.audioReactive === undefined ? DEFAULTS.audioReactive : Boolean(source.audioReactive),
    microphone: source.microphone === undefined ? DEFAULTS.microphone : Boolean(source.microphone),
  };
}

/**
 * 视觉设置只保存在表现层。改变它不会重建世界、发送网络消息或修改碰撞。
 * quality 是现有 RenderQuality.effective 的结果，低档会自动压低效果预算。
 */
export class VisualSettings {
  constructor(storage = null) {
    this.storage = storage;
    this.listeners = new Set();
    let saved = null;
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      if (raw) saved = JSON.parse(raw);
    } catch { /* 损坏或禁用存储时回到安全默认值。 */ }
    this.values = normalizeVisualSettings(saved);
  }

  get snapshot() { return Object.freeze({ ...this.values }); }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  update(patch) {
    this.values = normalizeVisualSettings({ ...this.values, ...patch });
    this.save();
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  save() {
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.values)); } catch { /* 本次设置仍有效。 */ }
  }

  exportJSON() {
    return JSON.stringify({
      schemaVersion: SCHEMA_VERSION,
      exportedBy: "orbit-game",
      settings: this.values,
    }, null, 2);
  }

  importJSON(raw) {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    const settings = parsed?.settings ?? parsed;
    if (!settings || typeof settings !== "object") throw new Error("视觉配置格式无效");
    this.values = normalizeVisualSettings(settings);
    this.save();
    const snapshot = this.snapshot;
    for (const listener of this.listeners) listener(snapshot);
    return snapshot;
  }

  effective(quality = "balanced") {
    const low = quality === "smooth";
    const medium = quality === "balanced";
    const particleCap = low ? 24 : medium ? 110 : 220;
    const trailCap = low ? 22 : medium ? 96 : 180;
    return {
      fluid: this.values.fluid && !low,
      background: this.values.background,
      skin: this.values.skin,
      customSkin: this.values.customSkin,
      particles: Math.min(particleCap, Math.round(this.values.particles * particleCap / 100)),
      trails: Math.min(trailCap, Math.round(this.values.trails * trailCap / 100)),
      distortion: this.values.distortion / 100,
      glow: this.values.glow && !low,
      audioReactive: this.values.audioReactive,
      microphone: this.values.microphone,
      maxFluidBalls: low ? 24 : medium ? 72 : 128,
    };
  }
}

export { STORAGE_KEY, SCHEMA_VERSION };
