/** 画质只改变绘制成本，不改变模拟步长、网络频率、球体质量或碰撞。 */
export const QUALITY_PRESETS = Object.freeze({
  smooth: { label: "流畅", dpr: 1, particles: 36, perEvent: 4, rings: 8, grid: false },
  balanced: { label: "均衡", dpr: 1.5, particles: 90, perEvent: 8, rings: 16, grid: true },
  detailed: { label: "精致", dpr: 2, particles: 180, perEvent: 15, rings: 32, grid: true },
});

export class RenderQuality {
  constructor(storage = null) {
    this.storage = storage;
    this.mode = "auto";
    try { const saved = storage?.getItem("orbit.quality"); if (["auto", ...Object.keys(QUALITY_PRESETS)].includes(saved)) this.mode = saved; } catch { /* 无存储权限也可使用。 */ }
    this.level = 1;
    this.resetSample();
  }
  resetSample() { this.cost = 0; this.frames = 0; this.sampleSeconds = 0; this.goodSeconds = 0; }
  setMode(mode) {
    if (!["auto", ...Object.keys(QUALITY_PRESETS)].includes(mode)) return false;
    this.mode = mode; this.resetSample();
    try { this.storage?.setItem("orbit.quality", mode); } catch { /* 本次设置仍然有效。 */ }
    return true;
  }
  get effective() { return this.mode === "auto" ? ["smooth", "balanced", "detailed"][this.level] : this.mode; }
  get preset() { return QUALITY_PRESETS[this.effective]; }
  get label() { return `${this.mode === "auto" ? "自动 · " : ""}${this.preset.label}`; }
  /** 采样实际绘制成本，避免把 Wi-Fi 延迟和人为暂停当成低帧率。升档前至少稳定 15 秒。 */
  observe(milliseconds, seconds, active) {
    if (this.mode !== "auto" || !active || !Number.isFinite(milliseconds) || seconds <= 0 || seconds > .1) return false;
    this.cost += milliseconds; this.frames++; this.sampleSeconds += seconds;
    if (this.sampleSeconds < 2) return false;
    const average = this.cost / this.frames;
    this.goodSeconds = average < 7 ? this.goodSeconds + this.sampleSeconds : 0;
    const previous = this.level;
    if (average > 14 && this.level > 0) { this.level--; this.goodSeconds = 0; }
    else if (this.goodSeconds >= 15 && this.level < 2) { this.level++; this.goodSeconds = 0; }
    this.cost = 0; this.frames = 0; this.sampleSeconds = 0;
    return this.level !== previous;
  }
}
