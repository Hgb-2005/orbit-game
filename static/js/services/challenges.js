import { buildDailyChallenge, shanghaiDate } from "../challenges/catalog.js";

const PENDING_KEY = "orbit.pending-daily-challenge";

const emptySummary = () => ({
  todayBest: 0,
  completionRate: 0,
  bestGrade: null,
  streak: 0,
  totalRuns: 0,
  recent: [],
});

function validGoals(goals) {
  return Array.isArray(goals) && goals.length === 3 &&
    goals.every(goal => goal && typeof goal.id === "string" &&
      Number.isFinite(goal.target) && goal.target > 0);
}

function validContract(contract, today = shanghaiDate()) {
  return contract && contract.date === today && contract.mode === "daily" &&
    typeof contract.seed === "string" && validGoals(contract.goals) &&
    contract.rules?.duration === 300 && contract.rules?.botCount === 13;
}

function validSummary(summary) {
  return summary && Number.isSafeInteger(summary.todayBest) &&
    Number.isSafeInteger(summary.completionRate) && Number.isSafeInteger(summary.streak) &&
    Array.isArray(summary.recent);
}

/**
 * 每日挑战服务缓存服务端契约、离线重试结算，并维护长期反馈。
 * 游戏规则层只读取契约；页面只读取本服务暴露的状态。
 */
export class ChallengeService {
  constructor(onChange = () => {}) {
    this.onChange = onChange;
    this.contract = buildDailyChallenge();
    this.summary = emptySummary();
    this.status = "loading";
    this.pending = [];
    this.inFlight = null;
    try {
      const saved = JSON.parse(localStorage.getItem(PENDING_KEY) ?? "[]");
      if (Array.isArray(saved)) {
        this.pending = saved.filter(run => run && typeof run.runId === "string").slice(-10);
      }
    } catch { /* 无浏览器存储时仍可直接提交。 */ }
    this.notify();
  }

  notify() {
    this.onChange({
      contract: this.contract,
      summary: this.summary,
      status: this.status,
      pending: this.pending.length,
    });
  }

  remember() {
    try {
      if (this.pending.length) localStorage.setItem(PENDING_KEY, JSON.stringify(this.pending));
      else localStorage.removeItem(PENDING_KEY);
    } catch { /* 当前页面仍保留内存队列。 */ }
  }

  todayContract() {
    if (this.contract.date !== shanghaiDate()) {
      this.contract = buildDailyChallenge();
      this.notify();
    }
    return structuredClone(this.contract);
  }

  async request(url, options = {}) {
    const response = await fetch(url, {
      cache: "no-store",
      ...options,
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      const problem = await response.json().catch(() => ({}));
      const error = new Error(problem.error || `HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }

  async loadToday() {
    const requestedDate = shanghaiDate();
    try {
      const data = await this.request("/api/challenge/today");
      if (!validContract(data, requestedDate)) throw new Error("服务端每日挑战契约无效");
      this.contract = {
        date: data.date,
        seed: data.seed,
        mode: data.mode,
        title: data.title,
        rules: data.rules,
        goals: data.goals,
      };
      if (validSummary(data.summary)) this.summary = data.summary;
      this.status = "saved";
    } catch {
      // 离线时采用同一确定性算法，仍可完整游玩；恢复网络后补交结算。
      this.contract = buildDailyChallenge(requestedDate);
      this.status = "offline";
    }
    this.notify();
    if (this.pending.length) await this.flush();
  }

  async loadSummary() {
    try {
      const summary = await this.request("/api/challenges/summary");
      if (!validSummary(summary)) throw new Error("无效的挑战汇总");
      this.summary = summary;
      this.status = "saved";
    } catch {
      this.status = "offline";
    }
    this.notify();
  }

  payload(snapshot, runId) {
    const result = snapshot.challenge?.result;
    if (snapshot.mode !== "daily" || snapshot.state !== "gameover" || !result?.finalized) return null;
    return {
      runId,
      challengeDate: snapshot.challenge.date,
      seed: snapshot.challenge.seed,
      mode: "daily",
      score: result.value,
      completion: result.completion,
      rank: result.rank,
      kills: result.kills,
      elapsed: result.elapsed,
      grade: result.grade,
      goals: result.goals.map(({ id, target, progress, state, failureReason }) => ({
        id, target, progress, state, failureReason,
      })),
    };
  }

  capture(snapshot, runId) {
    const run = this.payload(snapshot, runId);
    if (!run) return Promise.resolve();
    if (!this.pending.some(item => item.runId === run.runId) &&
      !this.summary.recent?.some(item => item.runId === run.runId)) {
      this.pending = this.pending.slice(-9).concat([run]);
      this.remember();
    }
    return this.flush();
  }

  flush() {
    if (this.inFlight || !this.pending.length) return this.inFlight ?? Promise.resolve();
    this.status = "saving";
    this.notify();
    this.inFlight = (async () => {
      try {
        while (this.pending.length) {
          const run = this.pending[0];
          try {
            const result = await this.request("/api/challenges", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(run),
            });
            if (result.saved !== true) throw new Error("挑战结算未确认");
            this.pending.shift();
            this.remember();
            if (validSummary(result)) this.summary = {
              todayBest: result.todayBest,
              completionRate: result.completionRate,
              bestGrade: result.bestGrade,
              streak: result.streak,
              totalRuns: result.totalRuns,
              recent: result.recent,
            };
          } catch (error) {
            // 过期日期或旧契约的数据永远无法再次通过服务端校验。
            // 丢弃这一条后继续补交后面的成绩，避免坏记录永久堵住队首。
            if ([400, 409, 422].includes(error.status)) {
              this.pending.shift();
              this.remember();
              continue;
            }
            throw error;
          }
        }
        this.status = "saved";
      } catch {
        this.status = "offline";
      } finally {
        this.inFlight = null;
        this.notify();
      }
    })();
    return this.inFlight;
  }

  flushOnExit() {
    if (!this.pending.length || !navigator.sendBeacon) return;
    const run = this.pending[0];
    navigator.sendBeacon("/api/challenges", new Blob([JSON.stringify(run)], {
      type: "application/json",
    }));
  }
}
