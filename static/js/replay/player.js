const clone = value => typeof structuredClone === "function" ? structuredClone(value) : JSON.parse(JSON.stringify(value));
const lerp = (a, b, t) => a + (b - a) * t;

export function validateRecording(recording) {
  if (!recording || recording.kind !== "orbit-replay" || recording.schemaVersion !== 1) {
    throw new Error("录像格式不受支持");
  }
  if (!Array.isArray(recording.frames) || recording.frames.length === 0) {
    throw new Error("录像没有可播放帧");
  }
  let previous = -1;
  for (const frame of recording.frames) {
    if (!frame || !Number.isFinite(frame.at) || frame.at < previous || !frame.snapshot) {
      throw new Error("录像时间轴损坏");
    }
    previous = frame.at;
  }
  return recording;
}

export function frameIndexAt(frames, seconds) {
  if (!frames?.length) return -1;
  const target = Math.max(0, Number(seconds) || 0);
  let low = 0, high = frames.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (frames[middle].at <= target) low = middle + 1;
    else high = middle - 1;
  }
  return Math.max(0, high);
}

function interpolateBall(a, b, t) {
  if (!a || !b || a.id !== b.id) return clone(a);
  return {
    ...clone(a),
    x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t),
    vx: lerp(a.vx ?? 0, b.vx ?? 0, t), vy: lerp(a.vy ?? 0, b.vy ?? 0, t),
    radius: lerp(a.radius, b.radius, t),
    // 质量代表权威玩法状态，不从两个采样推演出中间值。
    mass: a.mass,
    speed: lerp(a.speed ?? 0, b.speed ?? 0, t),
    mergeRemaining: lerp(a.mergeRemaining ?? 0, b.mergeRemaining ?? 0, t),
  };
}

function interpolateArray(first, second, t) {
  const nextById = new Map((second ?? []).map(item => [item.id, item]));
  return (first ?? []).map(item => interpolateBall(item, nextById.get(item.id), t));
}

function summaryCenter(cells, fallback) {
  if (!cells.length) return clone(fallback);
  const total = cells.reduce((sum, cell) => sum + Math.max(1, cell.mass), 0);
  const x = cells.reduce((sum, cell) => sum + cell.x * Math.max(1, cell.mass), 0) / total;
  const y = cells.reduce((sum, cell) => sum + cell.y * Math.max(1, cell.mass), 0) / total;
  return { ...clone(fallback), x, y };
}

/** 只插值表现坐标；质量、生命与事件仍来自最近的权威采样。 */
export function interpolateReplaySnapshots(first, second, t) {
  if (!second || t <= 0) return clone(first);
  const snapshot = clone(first);
  const amount = Math.max(0, Math.min(1, t));
  snapshot.playerCells = interpolateArray(first.playerCells, second.playerCells, amount);
  snapshot.bots = interpolateArray(first.bots, second.bots, amount);
  snapshot.player = summaryCenter(snapshot.playerCells, first.player);
  snapshot.cameraTarget = summaryCenter(snapshot.playerCells,
    first.cameraTarget ?? first.player);
  snapshot.spores = interpolateArray(first.spores, second.spores, amount);
  snapshot.pings = clone(first.pings ?? []);
  return snapshot;
}

export class ReplayPlayer {
  constructor(recording, { speed = 1 } = {}) {
    this.recording = validateRecording(recording);
    this.duration = Number(recording.duration) || this.recording.frames.at(-1).at;
    this.currentTime = 0;
    this.speed = [0.5, 1, 1.5, 2, 4].includes(speed) ? speed : 1;
    this.playing = false;
    this.replayCache = new Map();
    this.reconstruct(0);
  }

  play() {
    if (this.currentTime >= this.duration) this.currentTime = 0;
    this.playing = true;
  }

  pause() { this.playing = false; }
  toggle() { this.playing ? this.pause() : this.play(); }

  setSpeed(speed) {
    const parsed = Number(speed);
    if ([0.5, 1, 1.5, 2, 4].includes(parsed)) this.speed = parsed;
    return this.speed;
  }

  seek(seconds) {
    this.currentTime = Math.max(0, Math.min(this.duration, Number(seconds) || 0));
    return this.getSnapshot();
  }

  advance(dt) {
    if (!this.playing) return this.getSnapshot();
    this.currentTime = Math.min(this.duration, this.currentTime + Math.max(0, dt) * this.speed);
    if (this.currentTime >= this.duration) this.playing = false;
    return this.getSnapshot();
  }

  getSnapshot({ interpolate = true } = {}) {
    const index = frameIndexAt(this.recording.frames, this.currentTime);
    const current = this.reconstruct(index);
    if (!interpolate) return current;
    const next = this.recording.frames[index + 1];
    if (!next || current.state !== "playing" || next.snapshot.state !== "playing") return current;
    const span = next.at - this.recording.frames[index].at;
    const amount = span > 0 ? (this.currentTime - this.recording.frames[index].at) / span : 0;
    return interpolateReplaySnapshots(current, this.reconstruct(index + 1), amount);
  }

  eventsAtCurrentTime() {
    const index = frameIndexAt(this.recording.frames, this.currentTime);
    return clone(this.recording.frames[index]?.events ?? []);
  }

  reconstruct(index) {
    index = Math.max(0, Math.min(this.recording.frames.length - 1, index));
    if (this.replayCache.has(index)) return clone(this.replayCache.get(index));
    let keyIndex = -1;
    for (let cursor = index; cursor >= 0; cursor--) {
      if (this.recording.frames[cursor].foodFrame?.mode === "full") { keyIndex = cursor; break; }
    }
    if (keyIndex < 0) throw new Error("录像缺少食物恢复关键帧");
    const key = this.recording.frames[keyIndex];
    const foods = new Map((key.foods ?? []).map(food => [food.id, food]));
    const snapshot = clone(key.snapshot);
    for (let cursor = keyIndex + 1; cursor <= index; cursor++) {
      const delta = this.recording.frames[cursor].foodDelta;
      for (const id of delta?.removed ?? []) foods.delete(id);
      for (const food of delta?.upsert ?? []) foods.set(food.id, food);
      Object.assign(snapshot, clone(this.recording.frames[cursor].snapshot));
    }
    snapshot.foods = [...foods.values()];
    snapshot.state = index === this.recording.frames.length - 1 ? snapshot.state : "playing";
    this.replayCache.set(index, clone(snapshot));
    return clone(snapshot);
  }
}
