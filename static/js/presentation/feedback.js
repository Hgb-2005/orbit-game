import { CONFIG } from "../config.js";

/** 只记录表现层的状态变化，不写入世界。所有持续时间使用游戏时钟，暂停会自然冻结。 */
export class VisualFeedback {
  constructor() { this.reset(); }

  reset() {
    this.previous = null;
    this.cycle = null;
    this.elapsed = null;
    this.skillUntil = { sprint: 0, split: 0, spore: 0 };
    this.hotspotUntil = 0;
  }

  update(snapshot) {
    const { elapsed, state, hotspots } = snapshot;
    if (state === "ready" || (this.elapsed !== null && elapsed < this.elapsed)) this.reset();
    if (state === "playing") {
      for (const ability of ["sprint", "split", "spore"]) {
        if (!snapshot[ability]) continue;
        const ready = snapshot[ability].ready;
        // 首次开局只建立基线；只有实际从不可用变为可用才提示。
        if (this.previous && !this.previous[ability] && ready) {
          this.skillUntil[ability] = elapsed + CONFIG.feedback.skillReadySeconds;
        }
        if (!ready) this.skillUntil[ability] = 0;
      }
      this.previous = { sprint: snapshot.sprint?.ready ?? false, split: snapshot.split?.ready ?? false,
        spore: snapshot.spore?.ready ?? false };
      if (this.cycle !== null && hotspots.cycle > this.cycle) {
        this.hotspotUntil = elapsed + CONFIG.feedback.hotspotHighlightSeconds;
      }
    }
    if (state === "gameover") this.skillUntil = { sprint: 0, split: 0, spore: 0 };
    this.cycle = hotspots.cycle;
    this.elapsed = elapsed;
    const highlightRemaining = Math.max(0, this.hotspotUntil - elapsed);
    const warning = hotspots.remaining > 0 && hotspots.remaining <= CONFIG.feedback.hotspotWarningSeconds;
    const skills = { sprint: elapsed < this.skillUntil.sprint, split: elapsed < this.skillUntil.split };
    if (snapshot.spore) skills.spore = elapsed < this.skillUntil.spore;
    return {
      skills,
      hotspots: { phase: warning ? "warning" : highlightRemaining > 0 ? "relocated" : "normal", highlightRemaining },
    };
  }
}
