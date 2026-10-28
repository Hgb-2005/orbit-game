const PENDING_KEY = 'orbit.pending-history';

export function localMatch(snapshot, id) {
  if (!id || snapshot.network || snapshot.mode === 'practice' || snapshot.state !== 'gameover') return null;
  return { id, mode: snapshot.mode, duration: Number(snapshot.elapsed.toFixed(3)), score: snapshot.score,
    rank: snapshot.result?.rank ?? null, won: snapshot.result?.won ?? false,
    kills: snapshot.result?.kills ?? 0, stats: snapshot.stats };
}

/** 单机失败暂存在浏览器，联机仅读取归档；任何历史操作都不会改写最高分。 */
export class HistoryService {
  constructor(onChange = () => {}) {
    this.onChange = onChange; this.matches = []; this.pending = []; this.seen = new Set();
    this.status = 'loading'; this.inFlight = null;
    this.loadVersion = 0;
    try {
      const saved = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]');
      if (Array.isArray(saved)) this.pending = saved.filter(m => m && typeof m.id === 'string' && m.id.startsWith('local-')).slice(-20);
    } catch { /* 无存储权限时仍可保存到服务端。 */ }
  }
  remember() { try { localStorage.setItem(PENDING_KEY, JSON.stringify(this.pending)); } catch { /* 不影响当前会话重试。 */ } }
  capture(snapshot, id) {
    const match = localMatch(snapshot, id);
    if (!match || this.seen.has(id)) return;
    this.seen.add(id);
    if (!this.pending.some(m => m.id === id)) this.pending = this.pending.slice(-19).concat([match]);
    this.remember(); void this.flush();
  }
  async request(options = {}) {
    const response = await fetch('/api/history', { cache: 'no-store', ...options, signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }
  async load() {
    const version = ++this.loadVersion;
    try {
      const data = await this.request();
      if (!Array.isArray(data.matches)) throw new Error('无效的历史响应');
      if (version !== this.loadVersion) return;
      this.matches = data.matches; this.status = 'saved';
    } catch { if (version !== this.loadVersion) return; this.status = 'offline'; }
    this.onChange();
  }
  flush() {
    if (this.inFlight || !this.pending.length) return this.inFlight ?? Promise.resolve();
    this.inFlight = (async () => {
      try {
        while (this.pending.length) {
          const match = this.pending[0];
          const result = await this.request({ method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(match) });
          if (result.saved !== true || result.id !== match.id) throw new Error('未确认归档');
          this.pending.shift(); this.remember();
        }
        await this.load();
      } catch { this.status = 'offline'; this.onChange(); }
      finally { this.inFlight = null; }
    })();
    return this.inFlight;
  }
}
