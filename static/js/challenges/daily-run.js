const SPLIT_FOLLOW_UP_SECONDS = 2;

function clampProgress(value, target) {
  return Math.max(0, Math.min(target, Number.isFinite(value) ? value : 0));
}

function gradeFor(score) {
  if (score >= 4000) return "S";
  if (score >= 3000) return "A";
  if (score >= 2000) return "B";
  return "C";
}

function insideHotspot(snapshot) {
  const player = snapshot.player;
  if (!player) return false;
  return (snapshot.hotspots?.zones ?? []).some(zone =>
    Math.hypot(player.x - zone.x, player.y - zone.y) <= zone.radius);
}

/**
 * 每日挑战追踪器只消费会话快照和事件，不读 DOM、网络或时间 API。
 * 暂停时 Session 不调用 update，所以所有累计时间都会自然冻结。
 */
export class ChallengeTracker {
  constructor(contract) {
    if (!contract || contract.mode !== "daily" || !Array.isArray(contract.goals) || contract.goals.length !== 3) {
      throw new TypeError("每日挑战契约必须是包含 3 个目标的 daily 契约");
    }
    this.contract = structuredClone(contract);
    this.goals = new Map(this.contract.goals.map(goal => [goal.id, {
      ...goal,
      progress: clampProgress(goal.progress, goal.target),
      state: goal.state ?? "active",
      failureReason: goal.failureReason ?? "",
    }]));
    this.lastSplitAt = -Infinity;
    this.hotspotSeconds = 0;
    this.splitEats = 0;
    this.eatenBalls = 0;
    this.spikeLaunches = 0;
    this.spikesHit = 0;
    this.finalized = false;
    this.result = null;
  }

  goal(id) {
    return this.goals.get(id);
  }

  complete(id) {
    const goal = this.goal(id);
    if (!goal || goal.state === "completed") return;
    goal.progress = goal.target;
    goal.state = "completed";
    goal.failureReason = "";
  }

  advance(id, value, { final = false, reason = "" } = {}) {
    const goal = this.goal(id);
    if (!goal || goal.state === "completed" || goal.state === "failed") return;
    goal.progress = clampProgress(Math.max(goal.progress, value), goal.target);
    if (goal.progress >= goal.target) this.complete(id);
    else if (final) {
      goal.state = "failed";
      goal.failureReason = reason || `未达到目标：${Math.floor(goal.progress)} / ${goal.target}`;
    } else {
      goal.state = "active";
    }
  }

  fail(id, reason) {
    const goal = this.goal(id);
    if (!goal || goal.state === "completed") return;
    goal.state = "failed";
    goal.failureReason = reason;
  }

  consumeEvents(snapshot, events) {
    for (const event of events ?? []) {
      if (event.type === "split") this.lastSplitAt = snapshot.elapsed;
      if (event.type === "eat") {
        this.eatenBalls++;
        if (snapshot.elapsed - this.lastSplitAt <= SPLIT_FOLLOW_UP_SECONDS + 1e-6) {
          this.splitEats++;
          this.advance("split-double", this.splitEats);
        }
        const combo = Number(event.combo) || 0;
        if (combo >= 3) this.advance("combo-three", combo);
      }
      if (event.type === "combo" && event.isPlayer && Number(event.count) >= 3) {
        this.advance("combo-three", Number(event.count));
      }
      if (event.type === "spike") {
        this.spikesHit++;
        this.fail("no-spike", "本局已触发扎刺，无法完成无伤穿行。");
      }
      if (event.type === "spike-launch" && event.actorId === "player") {
        this.spikeLaunches++;
        this.advance("spike-launch", this.spikeLaunches);
      }
    }
  }

  score(snapshot, completed) {
    const rank = Number(snapshot.result?.rank ?? snapshot.survival?.player?.rank ?? snapshot.leaderboard?.player?.rank ?? 99);
    const kills = Number(snapshot.result?.kills ?? snapshot.survival?.player?.kills ?? snapshot.stats?.cellsEaten ?? 0);
    // 提交给服务端的 elapsed 精确到毫秒，分数也必须使用同一个值，
    // 否则 0.0005 秒级的尾差可能让客户端和服务端复核结果相差 1 分。
    const elapsed = Math.round((Number(snapshot.elapsed) || 0) * 1000) / 1000;
    const rankBonus = rank === 1 ? 1000 : rank === 2 ? 750 : rank === 3 ? 500 : rank <= 7 ? 250 : 0;
    const value = completed * 900 + rankBonus + Math.round(kills * 120) + Math.round(elapsed * 2);
    return {
      value,
      grade: gradeFor(value),
      rank,
      kills,
      activeSeconds: Math.round((Number(snapshot.stats?.activeSeconds) || Number(snapshot.elapsed) || 0) * 10) / 10,
      completedGoals: completed,
    };
  }

  finalize(snapshot) {
    if (this.finalized) return this.result;
    const rank = Number(snapshot.result?.rank ?? snapshot.survival?.player?.rank ?? 99);
    this.advance("top-three", rank <= 3 ? 3 : 0, {
      final: true,
      reason: `最终第 ${rank} 名，需要进入前三名。`,
    });
    this.advance("eat-three", this.eatenBalls, {
      final: true,
      reason: `本局吞噬 ${this.eatenBalls} 个球，需要 ${this.goal("eat-three")?.target ?? 3} 个。`,
    });
    this.advance("combo-three", 0, {
      final: true,
      reason: "本局没有完成三连吞噬。",
    });
    this.advance("survive-time", Number(snapshot.elapsed) || 0, {
      final: true,
      reason: `本局存活 ${Math.floor(Number(snapshot.elapsed) || 0)} 秒。`,
    });
    this.advance("spike-launch", this.spikeLaunches, {
      final: true,
      reason: "本局没有成功发射反击刺。",
    });
    this.advance("peak-mass", Number(snapshot.peakMass) || Number(snapshot.player?.mass) || 0, {
      final: true,
      reason: `峰值质量 ${Math.floor(snapshot.peakMass ?? snapshot.player?.mass ?? 0)} m。`,
    });
    this.advance("hotspot-time", this.hotspotSeconds, {
      final: true,
      reason: `富集区累计停留 ${Math.floor(this.hotspotSeconds)} 秒。`,
    });
    this.advance("split-double", this.splitEats, {
      final: true,
      reason: "本局没有完成分裂后的 2 秒连食。",
    });
    this.advance("no-spike", this.spikesHit === 0 ? 1 : 0, {
      final: true,
      reason: "本局触发过扎刺。",
    });
    const goals = this.contract.goals.map(({ id }) => {
      const goal = this.goal(id);
      return {
        id,
        label: goal.label,
        description: goal.description,
        target: goal.target,
        unit: goal.unit,
        progress: Math.round(goal.progress * 10) / 10,
        state: goal.state,
        failureReason: goal.failureReason,
      };
    });
    const completed = goals.filter(goal => goal.state === "completed").length;
    const scoring = this.score(snapshot, completed);
    this.finalized = true;
    this.result = {
      ...scoring,
      completion: Math.round(completed / goals.length * 100),
      elapsed: Math.round((Number(snapshot.elapsed) || 0) * 1000) / 1000,
      goals,
      finalized: true,
    };
    return this.result;
  }

  update(snapshot, events = [], dt = 0) {
    if (!snapshot || snapshot.mode !== "daily") return this.snapshot();
    if (!this.finalized) {
      this.consumeEvents(snapshot, events);
      this.advance("eat-three", this.eatenBalls);
      this.advance("peak-mass", Number(snapshot.peakMass) || Number(snapshot.player?.mass) || 0);
      this.advance("survive-time", Number(snapshot.elapsed) || 0);
      if (insideHotspot(snapshot) && snapshot.state === "playing") {
        this.hotspotSeconds = Math.min(3600, this.hotspotSeconds + Math.max(0, dt));
        this.advance("hotspot-time", this.hotspotSeconds);
      }
      if (snapshot.state === "gameover") this.finalize(snapshot);
    }
    return this.snapshot();
  }

  snapshot() {
    const liveGoals = this.contract.goals.map(({ id }) => {
      const goal = this.goal(id);
      return {
        id,
        label: goal.label,
        description: goal.description,
        target: goal.target,
        unit: goal.unit,
        progress: Math.round(goal.progress * 10) / 10,
        state: goal.state,
        failureReason: goal.failureReason,
      };
    });
    return {
      date: this.contract.date,
      seed: this.contract.seed,
      title: this.contract.title,
      rules: { ...this.contract.rules },
      goals: liveGoals,
      finalized: this.finalized,
      result: this.result ? structuredClone(this.result) : null,
    };
  }
}
