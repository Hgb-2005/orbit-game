const REPLAY_SCHEMA = 1;
const DEFAULT_SAMPLE_SECONDS = 0.1;
const DEFAULT_KEYFRAME_SECONDS = 5;
const MAX_CAPTURE_SECONDS = 10 * 60;

const clone = value => {
  if (value == null) return value;
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
};

const rounded = value => Number.isFinite(value) ? Math.round(value * 100) / 100 : value;

/** 录制数据不依赖类实例，便于 IndexedDB 存储和跨页面版本迁移。 */
function compactCell(cell) {
  if (!cell) return null;
  return {
    id: cell.id, ownerId: cell.ownerId, name: cell.name, color: cell.color,
    isPlayer: Boolean(cell.isPlayer), isAlly: Boolean(cell.isAlly), team: cell.team,
    x: rounded(cell.x), y: rounded(cell.y), vx: rounded(cell.vx), vy: rounded(cell.vy),
    mass: rounded(cell.mass), radius: rounded(cell.radius), speed: rounded(cell.speed),
    mergeRemaining: rounded(cell.mergeRemaining), alive: cell.alive !== false,
    motion: Boolean(cell.motion),
  };
}

function compactFood(food) {
  return {
    id: food.id, x: rounded(food.x), y: rounded(food.y), radius: rounded(food.radius),
    color: food.color, mass: rounded(food.mass), hotspotId: food.hotspotId ?? null,
  };
}

function compactItems(items) {
  if (!items) return null;
  return {
    items: (items.items ?? []).map(item => ({
      id: item.id, type: item.type, x: rounded(item.x), y: rounded(item.y),
      radius: rounded(item.radius), color: item.color, symbol: item.symbol,
    })),
    effects: clone(items.effects ?? {}),
    combo: clone(items.combo ?? null),
  };
}

function compactSurvival(survival) {
  if (!survival) return null;
  return {
    duration: survival.duration, remaining: survival.remaining, active: survival.active,
    total: survival.total, player: clone(survival.player), standings: clone(survival.standings),
    protectionByOwner: clone(survival.protectionByOwner ?? {}),
  };
}

/**
 * 快照只保留绘制与结算所需字段。录制模块不能持有真实世界对象的引用，
 * 否则下一帧的物理更新会悄悄改写已经采样的历史。
 */
export function compactReplaySnapshot(snapshot) {
  if (!snapshot) throw new Error("无法录制空快照");
  return {
    state: snapshot.state, mode: snapshot.mode, elapsed: rounded(snapshot.elapsed),
    score: snapshot.score, eatenBalls: snapshot.eatenBalls, killer: snapshot.killer ?? "",
    protectionRemaining: rounded(snapshot.protectionRemaining ?? 0),
    bounds: clone(snapshot.bounds), map: clone(snapshot.map ?? null),
    obstacles: clone(snapshot.obstacles ?? []),
    player: compactCell(snapshot.player),
    cameraTarget: compactCell(snapshot.cameraTarget ?? snapshot.player),
    playerCells: (snapshot.playerCells ?? []).map(compactCell).filter(Boolean),
    bots: (snapshot.bots ?? []).map(compactCell).filter(Boolean),
    spores: clone(snapshot.spores ?? []), spikes: clone(snapshot.spikes ?? []),
    grouping: Boolean(snapshot.regrouping), regrouping: Boolean(snapshot.regrouping),
    sprint: clone(snapshot.sprint ?? { active: false }), split: clone(snapshot.split ?? {}),
    spore: clone(snapshot.spore ?? {}), stage: clone(snapshot.stage ?? null),
    difficulty: clone(snapshot.difficulty ?? null), hotspots: clone(snapshot.hotspots ?? { zones: [], remaining: 0 }),
    items: compactItems(snapshot.items), safeZone: clone(snapshot.safeZone ?? null),
    pings: clone(snapshot.pings ?? []), leaderboard: clone(snapshot.leaderboard ?? { entries: [] }),
    survival: compactSurvival(snapshot.survival), result: clone(snapshot.result ?? null),
    team: clone(snapshot.team ?? null), practice: snapshot.practice ? { id: snapshot.practice.id, title: snapshot.practice.title } : null,
    spectating: Boolean(snapshot.spectating),
  };
}

const foodKey = food => [
  food.id, food.x, food.y, food.radius, food.color, food.mass, food.hotspotId,
].join("|");

export class ReplayRecorder {
  constructor({ sampleSeconds = DEFAULT_SAMPLE_SECONDS, keyframeSeconds = DEFAULT_KEYFRAME_SECONDS,
    maxSeconds = MAX_CAPTURE_SECONDS, now = () => Date.now(),
    idFactory = () => globalThis.crypto?.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}` } = {}) {
    this.sampleSeconds = Math.max(0.05, Number(sampleSeconds) || DEFAULT_SAMPLE_SECONDS);
    this.keyframeSeconds = Math.max(this.sampleSeconds, Number(keyframeSeconds) || DEFAULT_KEYFRAME_SECONDS);
    this.maxSeconds = Math.max(this.keyframeSeconds, Number(maxSeconds) || MAX_CAPTURE_SECONDS);
    this.now = now;
    this.idFactory = idFactory;
    this.reset();
  }

  reset() {
    this.active = false;
    this.recording = null;
    this.lastGameTime = 0;
    this.lastFoods = new Map();
    this.lastKeyframeAt = -Infinity;
    this.eventBuffer = [];
    this.finalEventBuffer = [];
  }

  start(snapshot, metadata = {}) {
    this.reset();
    if (!snapshot || snapshot.state !== "playing") return null;
    const id = `${metadata.source === "server" ? "server" : "local"}-${this.idFactory()}`;
    this.recording = {
      schemaVersion: REPLAY_SCHEMA, id, kind: "orbit-replay",
      createdAt: new Date(this.now()).toISOString(),
      source: metadata.source === "server" ? "server" : "local",
      roomId: metadata.roomId ?? null, title: metadata.title ?? "",
      sampleSeconds: this.sampleSeconds, keyframeSeconds: this.keyframeSeconds,
      completed: false, frames: [],
    };
    this.active = true;
    this.lastGameTime = Number(snapshot.elapsed) || 0;
    this._appendSnapshot(snapshot, [], true);
    return this.recording.id;
  }

  appendEvents(events = []) {
    if (!this.active) return;
    for (const event of events) {
      if (!event || typeof event.type !== "string") continue;
      this.eventBuffer.push(clone(event));
    }
  }

  capture(snapshot, events = []) {
    if (!this.active || !snapshot) return false;
    this.appendEvents(events);
    const gameTime = Number(snapshot.elapsed);
    if (!Number.isFinite(gameTime) || gameTime >= this.maxSeconds) return false;
    if (gameTime - this.lastGameTime + 1e-6 < this.sampleSeconds) return false;
    this._appendSnapshot(snapshot, this.eventBuffer.splice(0), false);
    this.lastGameTime = gameTime;
    return true;
  }

  finish(snapshot, events = []) {
    if (!this.active || !this.recording) return null;
    this.appendEvents(events);
    // 结算帧必须进入录像，即使它距离上一个 10 Hz 采样不足 100 ms；
    // 与上一帧同一时间时合并事件，同时刷新最终状态，保证 gameover 不丢。
    if (snapshot) this._appendSnapshot(snapshot, this.eventBuffer.splice(0), false, true);
    this.finalEventBuffer = [];
    const recording = this.recording;
    const finalFrame = recording.frames.at(-1);
    const finalSnapshot = finalFrame?.snapshot ?? {};
    recording.completed = true;
    recording.duration = rounded(Math.max(0, finalSnapshot.elapsed ?? finalFrame?.at ?? 0));
    recording.score = Math.round(finalSnapshot.score ?? 0);
    recording.mode = finalSnapshot.mode ?? "classic";
    recording.mapName = finalSnapshot.map?.name ?? "标准球场";
    recording.title = recording.title || `${recording.mapName} · ${recording.score} 分`;
    recording.frameCount = recording.frames.length;
    recording.size = new Blob([JSON.stringify(recording)]).size;
    this.active = false;
    this.reset();
    return recording;
  }

  discard() {
    this.reset();
  }

  _appendSnapshot(snapshot, events, forceKeyframe, allowSmallStep = false) {
    const at = rounded(Number(snapshot.elapsed) || 0);
    const previous = this.recording.frames.at(-1);
    if (previous && !allowSmallStep && at - previous.at < this.sampleSeconds - 1e-6) return;
    if (previous && allowSmallStep && Math.abs(at - previous.at) < 1e-4) {
      previous.events.push(...events);
      previous.snapshot = compactReplaySnapshot(snapshot);
      this._appendFoodDelta(previous, snapshot.foods ?? [], true);
      return;
    }
    const keyframe = forceKeyframe || at - this.lastKeyframeAt >= this.keyframeSeconds;
    const frame = {
      at, events: events.map(clone), snapshot: compactReplaySnapshot(snapshot),
      foodFrame: keyframe ? { mode: "full" } : { mode: "delta" },
    };
    this._appendFoodDelta(frame, snapshot.foods ?? [], keyframe);
    this.recording.frames.push(frame);
    if (keyframe) this.lastKeyframeAt = at;
  }

  _appendFoodDelta(frame, foods, keyframe) {
    const next = new Map();
    if (keyframe) {
      frame.foods = foods.map(compactFood);
      for (const food of frame.foods) next.set(food.id, foodKey(food));
    } else {
      const upsert = [];
      for (const source of foods) {
        const food = compactFood(source);
        const key = foodKey(food);
        next.set(food.id, key);
        if (this.lastFoods.get(food.id) !== key) upsert.push(food);
      }
      const removed = [...this.lastFoods.keys()].filter(id => !next.has(id));
      frame.foodDelta = { upsert, removed };
    }
    this.lastFoods = next;
  }
}

export const REPLAY_LIMITS = Object.freeze({
  schema: REPLAY_SCHEMA,
  sampleSeconds: DEFAULT_SAMPLE_SECONDS,
  keyframeSeconds: DEFAULT_KEYFRAME_SECONDS,
  maxSeconds: MAX_CAPTURE_SECONDS,
});
