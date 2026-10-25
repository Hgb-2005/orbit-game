const PENDING_KEY = "orbit.pending-score";

function readPending() {
  try {
    const value = Number(localStorage.getItem(PENDING_KEY));
    return Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : 0;
  } catch {
    return 0;
  }
}

/** 失败时暂存待同步分数；以 SQLite 返回值作为最终记录。 */
export class ScoreService {
  constructor(onChange) {
    this.pending = readPending();
    this.highScore = this.pending;
    this.serverScore = 0;
    this.status = "loading";
    this.inFlight = null;
    this.onChange = onChange;
  }

  notify() {
    this.onChange({ highScore: this.highScore, status: this.status, pending: this.pending });
  }

  rememberPending() {
    try {
      if (this.pending) localStorage.setItem(PENDING_KEY, String(this.pending));
      else localStorage.removeItem(PENDING_KEY);
    } catch {
      // 禁止本地存储的浏览器仍可正常通过 API 保存，本地重试仅为额外保障。
    }
  }

  async request(url, options = {}) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(url, { ...options, signal: controller.signal, cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const result = await response.json();
      if (!Number.isSafeInteger(result.high_score) || result.high_score < 0) throw new Error("无效的分数响应");
      return result;
    } finally {
      clearTimeout(timeout);
    }
  }

  async load() {
    try {
      const result = await this.request("/api/high-score");
      this.serverScore = Math.max(this.serverScore, result.high_score);
      this.highScore = Math.max(this.highScore, this.serverScore);
      if (this.pending <= this.serverScore) this.pending = 0;
      this.rememberPending();
      this.status = this.pending ? "pending" : "saved";
    } catch {
      this.status = "offline";
    }
    this.notify();
    if (this.pending) await this.flush();
  }

  observe(score) {
    this.highScore = Math.max(this.highScore, score);
    if (score > this.serverScore && score > this.pending) {
      this.pending = score;
      this.rememberPending();
      if (this.status !== "offline" && this.status !== "saving") this.status = "pending";
    }
    this.notify();
  }

  flush() {
    if (this.inFlight) return this.inFlight;
    if (!this.pending) return Promise.resolve();
    const score = this.pending;
    this.status = "saving";
    this.notify();
    this.inFlight = this.request("/api/scores", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ score }),
    }).then(result => {
      this.serverScore = Math.max(this.serverScore, result.high_score);
      this.highScore = Math.max(this.highScore, this.serverScore);
      if (this.pending <= this.serverScore) this.pending = 0;
      this.status = this.pending ? "pending" : "saved";
      this.rememberPending();
    }).catch(() => {
      this.status = "offline";
    }).finally(() => {
      this.inFlight = null;
      this.notify();
    });
    return this.inFlight;
  }

  flushOnExit() {
    if (!this.pending || !navigator.sendBeacon) return;
    const body = new Blob([JSON.stringify({ score: this.pending })], { type: "application/json" });
    navigator.sendBeacon("/api/scores", body);
    // Beacon 无法确认响应，所以保留待同步值，下次打开时再核对数据库。
  }
}
