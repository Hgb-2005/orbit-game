import { summarizeCells } from "../core/cells.js";
import { getDifficulty, getStage } from "../core/progression.js";
import { PositionBuffer } from "./position-buffer.js";
import { Spectator } from './spectator.js';
import { MovementPrediction } from './movement-prediction.js';

/** 远程会话只发送输入和读取快照，永不在客户端计算吞噬、生命或分数。 */
export class RemoteSession {
  constructor(placeholder, onChange = () => {}, socketFactory = url => new WebSocket(url), now = () => performance.now()) {
    this.placeholder = placeholder;
    this.spectator = new Spectator();
    this.onChange = onChange;
    this.socketFactory = socketFactory;
    this.now = now;
    this.lastMessageAt = this.now();
    this.nextPingAt = this.now() + 3000;
    this.heartbeatTimer = null;
    this.stopPending = false;
    this.socket = null;
    this.playerId = "";
    this.resumeToken = "";
    this.room = null;
    this.raw = null;
    this.customRecord = null;
    this.foods = [];
    this.foodVersion = -1;
    this.foodRound = "";
    this.foodResyncPending = false;
    this.positionBuffer = new PositionBuffer();
    this.prediction = new MovementPrediction();
    this.traffic = [];
    this.lastActions = { split: false, spore: false };
    this.state = "ready";
    this.connection = "idle";
    this.error = "";
    this.rtt = null;
    this.seq = 0;
    this.events = [];
    this.eventCursor = 0;
    this.roundId = "";
    this.positions = new Map();
    this.stateReceivedAt = 0;
    this.previousRanks = new Map();
    this.rankMovement = new Map();
    this.sendTimer = 0;
    this.queued = { split: false, spore: false };
    this.inactive = false;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.manualClose = false;
    this.resumePending = false;
    this.resumeInputAfterReconnect = true;
    this.finishConnection = null;
  }

  async connect({ resume = false } = {}) {
    if (this.connection === "connected") return;
    if (this.connecting) return this.connecting;
    this.connection = resume ? "reconnecting" : "connecting"; this.error = ""; this.onChange();
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = this.socketFactory(`${scheme}//${location.host}/ws/arena`);
    this.socket = socket;
    this.lastMessageAt = this.now();
    this.nextPingAt = this.now() + 3000;
    this.stopHeartbeat();
    // 与绘制循环分离：后台标签被降帧时仍可探活，回前台时按实际时间补检查。
    this.heartbeatTimer = setInterval(() => this.checkConnection(), 1000);
    this.heartbeatTimer.unref?.();
    // 恢复必须使用断线前保存的凭证。服务端会为这个“新连接”另发一个
    // 临时 token，但它不能替代旧玩家的恢复 token。
    const resumeToken = resume ? this.resumeToken : "";
    this.connecting = new Promise((resolve, reject) => {
      let settled = false;
      let timeout = null;
      const finish = (error = null) => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        timeout = null;
        if (error) reject(error); else resolve();
      };
      this.finishConnection = finish;
      timeout = setTimeout(() => {
        const error = new Error(resume ? "恢复连接超时。" : "连接超时，请检查服务器是否启动。");
        finish(error); socket.close();
      }, 7000);
      socket.addEventListener("message", event => {
        if (socket !== this.socket) return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (!message || typeof message.type !== "string") return;
        const now = this.now();
        this.lastMessageAt = now;
        this.traffic = this.traffic.filter(sample => now - sample.time < 1000);
        this.traffic.push({ time: now, bytes: new TextEncoder().encode(event.data).length });
        if (message.type === "welcome") {
          if (resume && resumeToken) {
            this.resumePending = true;
            // 此时连接状态仍是 reconnecting，不能走只允许 connected 的普通输入通道。
            if (socket.readyState === 1 && socket.bufferedAmount <= 128 * 1024) {
              try { socket.send(JSON.stringify({ type: "resume", token: resumeToken })); }
              catch { finish(new Error("恢复凭证发送失败。")); socket.close(); }
            } else {
              finish(new Error("恢复连接未能发送凭证。")); socket.close();
            }
          } else if (resume) {
            finish(new Error("恢复凭证已丢失。")); socket.close();
          } else {
            this.resumeToken = message.resumeToken || this.resumeToken;
            this.connection = "connected"; this.playerId = message.playerId;
            this.onChange(); finish();
          }
        } else this.receive(message);
      });
      socket.addEventListener("close", () => {
        clearTimeout(timeout);
        if (socket !== this.socket) return;
        this.stopHeartbeat();
        this.socket = null;
        this.prediction.reset();
        this.resumePending = false;
        finish(new Error(this.error || "连接已断开。"));
        if (!this.manualClose && this.room) {
          this.connection = "reconnecting";
          this.error = "连接中断，正在尝试恢复本局…";
          this.resumeInputAfterReconnect = !this.inactive;
          this.inactive = true;
          this.scheduleReconnect();
        } else {
          this.connection = "disconnected";
          this.error = this.error || "连接已断开，可重新创建或加入房间。";
          this.state = "ready"; this.raw = null; this.room = null; this.positions.clear(); this.events = [];
        }
        this.onChange();
      });
      socket.addEventListener("error", () => { this.error = "无法连接联机服务器，请检查网络和启动窗口。"; this.onChange(); });
    }).finally(() => { this.connecting = null; this.finishConnection = null; });
    return this.connecting;
  }

  scheduleReconnect() {
    if (this.reconnectTimer || this.manualClose || !this.room) return;
    const delays = [350, 700, 1400, 2500, 4000, 6000, 8000];
    const delay = delays[Math.min(this.reconnectAttempt++, delays.length - 1)];
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect({ resume: true }).catch(() => this.scheduleReconnect());
    }, delay);
  }

  cancelReconnect() {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  send(message) {
    if (this.connection !== "connected" || this.socket?.readyState !== 1) return false;
    if (this.socket.bufferedAmount > 128 * 1024) return false;
    try { this.socket.send(JSON.stringify(message)); return true; }
    catch { this.recoverConnection("发送失败，正在恢复连接…"); return false; }
  }

  stopHeartbeat() {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  checkConnection() {
    if (this.connection !== "connected" || !this.socket) return;
    const now = this.now();
    if (now - this.lastMessageAt >= 8000) {
      this.recoverConnection("服务器暂时无响应，正在恢复连接…");
      return;
    }
    if (this.stopPending) this.stopPending = !this.send({ type: "stop" });
    if (now >= this.nextPingAt) {
      this.nextPingAt = now + 3000;
      this.send({ type: "ping", sent: now });
    }
  }

  recoverConnection(message) {
    this.prediction.reset();
    const socket = this.socket;
    this.socket = null;
    this.stopHeartbeat();
    this.finishConnection?.(new Error(message));
    this.resumePending = false;
    this.resumeInputAfterReconnect = !this.inactive;
    this.inactive = true;
    this.connection = this.room && !this.manualClose ? "reconnecting" : "disconnected";
    this.error = message;
    try { socket?.close(); } catch { /* 已失效的传输不影响重试调度。 */ }
    if (this.room && !this.manualClose) this.scheduleReconnect();
    this.onChange();
  }

  async enter(type, name, code, rules) {
    try {
      this.manualClose = false;
      this.cancelReconnect();
      await this.connect();
      this.error = "";
      this.send({ type, name: name.trim(), code: code?.trim(), ...(type === "create" && rules ? { rules } : {}) });
    } catch (error) { this.error = error.message; }
    this.onChange();
  }

  receive(message) {
    this.lastMessageAt = this.now();
    if (message.type === "resumed") {
      this.playerId = message.playerId || this.playerId;
      this.resumePending = false;
      this.connection = "connected";
      this.error = "";
      this.reconnectAttempt = 0;
      this.positionBuffer.reset();
      this.prediction.reset();
      this.inactive = !this.resumeInputAfterReconnect;
      this.queued = { split: false, spore: false };
      this.lastActions = { split: false, spore: false };
      this.events.push({ type: "networkresume" });
      this.finishConnection?.();
      this.onChange();
    } else if (message.type === "room") {
      this.room = message;
      if (message.state === "waiting") {
        this.raw = null; this.state = "ready"; this.positions.clear(); this.events = [];
        this.roundId = ""; this.eventCursor = 0; this.seq = 0; this.stateReceivedAt = 0; this.previousRanks.clear(); this.rankMovement.clear();
        this.resetReplication();
      }
      this.error = ""; this.onChange();
    } else if (message.type === "left") {
      this.room = null; this.raw = null; this.state = "ready"; this.roundId = "";
      this.positions.clear(); this.events = []; this.stateReceivedAt = 0; this.previousRanks.clear(); this.rankMovement.clear(); this.error = ""; this.onChange();
      this.resetReplication();
    } else if (message.type === "error") {
      this.error = message.message;
      if (this.resumePending) {
        this.resumePending = false;
        if (message.code === "resume_expired") {
          this.room = null; this.raw = null; this.roundId = ""; this.state = "ready";
          this.positions.clear(); this.resetReplication(); this.cancelReconnect();
        }
        this.socket?.close();
      }
      this.onChange();
    } else if (message.type === "record_saved") {
      if (message.scope === "custom") {
        if (message.roundId !== this.roundId) return;
        this.customRecord = message.record;
        this.onChange();
      } else this.events.push({ type: "record_saved" });
    } else if (message.type === 'history_saved') {
      this.events.push({ type: 'history_saved' });
    } else if (message.type === "pong") {
      if (Number.isFinite(message.sent)) this.rtt = Math.max(0, Math.round(this.now() - message.sent));
    } else if (message.type === "foods" && message.roundId === this.room?.roundId) {
      if (this.foodRound === message.roundId && (message.version ?? 0) < this.foodVersion) return;
      this.foods = message.foods;
      this.foodVersion = message.version ?? 0;
      this.foodRound = message.roundId;
      this.foodResyncPending = false;
    } else if (message.type === "food_patch" && message.roundId === this.room?.roundId) {
      if (this.foodRound === message.roundId && message.version <= this.foodVersion) return;
      if (this.foodRound !== message.roundId || message.baseVersion !== this.foodVersion) {
        if (!this.foodResyncPending) this.foodResyncPending = this.send({ type: "resync_foods", roundId: message.roundId });
        return;
      }
      const foods = new Map(this.foods.map(food => [food.id, food]));
      for (const id of message.removed) foods.delete(id);
      for (const food of message.upsert) foods.set(food.id, food);
      this.foods = [...foods.values()];
      this.foodVersion = message.version;
    } else if (message.type === "state" && this.room && this.room.state !== "waiting" && message.roundId === this.room.roundId) {
      const newRound = this.roundId !== message.roundId;
      if (!newRound && message.world.tick < this.raw?.tick) return;
      if (newRound) {
        this.customRecord = null;
        this.spectator.reset();
        this.roundId = message.roundId; this.eventCursor = 0; this.seq = 0;
        this.positions.clear(); this.previousRanks.clear(); this.rankMovement.clear(); this.events = [{ type: "networkstart" }];
        this.sendTimer = .05; this.queued = { split: false, spore: false }; this.inactive = false;
        this.positionBuffer.reset(); this.lastActions = { split: false, spore: false };
        this.prediction.reset();
      }
      this.raw = message.world;
      this.stateReceivedAt = this.now();
      this.positionBuffer.push(this.raw, this.stateReceivedAt);
      this.state = this.raw.finished ? "gameover" : "playing";
      const nextRanks = new Map();
      for (const entry of this.raw.standings) {
        nextRanks.set(entry.ownerId, entry.rank);
        const previous = this.previousRanks.get(entry.ownerId);
        this.rankMovement.set(entry.ownerId, previous === undefined ? 0 : previous - entry.rank);
      }
      this.previousRanks = nextRanks;
      const live = new Set(this.raw.cells.map(cell => cell.id));
      for (const id of this.positions.keys()) if (!live.has(id)) this.positions.delete(id);
      for (const cell of this.raw.cells) if (!this.positions.has(cell.id)) this.positions.set(cell.id, { x: cell.x, y: cell.y });
      if (!this.inactive && this.connection === 'connected') {
        const resetOwn = this.prediction.reconcile(this.raw, this.playerId);
        if (resetOwn) for (const cell of this.raw.cells) if (cell.ownerId === this.playerId) {
          this.positions.set(cell.id, { x: cell.x, y: cell.y });
        }
      } else this.prediction.reset();
      const eatenFood = new Set();
      for (const event of this.raw.events) {
        if (event.id <= this.eventCursor) continue;
        this.eventCursor = event.id;
        if (event.type === "food") eatenFood.add(event.foodId);
        if (!event.ownerId || event.ownerId === this.playerId || event.type === "departed") {
          this.events.push({ ...event, isPlayer: event.ownerId === this.playerId });
        }
      }
      if (eatenFood.size) this.foods = this.foods.filter(food => !eatenFood.has(food.id));
      if (newRound || this.state === "gameover") this.onChange();
    }
  }

  stop() {
    this.prediction.reset();
    this.inactive = true;
    this.resumeInputAfterReconnect = false;
    this.queued = { split: false, spore: false };
    this.lastActions = { split: false, spore: false };
    this.stopPending = !this.send({ type: "stop" });
  }

  resetReplication() {
    this.prediction.reset();
    this.foods = []; this.foodVersion = -1; this.foodRound = ""; this.foodResyncPending = false;
    this.positionBuffer.reset(); this.lastActions = { split: false, spore: false };
  }

  resumeInput() {
    this.resumeInputAfterReconnect = true;
    this.stopPending = false;
    if (this.connection === "connected") this.inactive = false;
  }
  leave() {
    this.close();
    this.room = null; this.raw = null; this.state = "ready"; this.roundId = "";
    this.resumeToken = ""; this.playerId = ""; this.error = ""; this.events = [];
    this.positions.clear(); this.previousRanks.clear(); this.rankMovement.clear();
    this.stateReceivedAt = 0; this.resetReplication(); this.onChange();
  }
  ready(value) { this.send({ type: "ready", ready: value }); }
  start() { this.send({ type: "start" }); }
  rematch() { this.send({ type: "rematch" }); }
  configure(rules) { this.send({ type: "configure", rules }); }
  chooseTeam(team) { this.send({ type: 'choose_team', team }); }
  ping(kind, point) {
    if (this.connection !== 'connected' || this.state !== 'playing') return false;
    return this.send({ type: 'team_ping', roundId: this.roundId, kind, x: point.x, y: point.y });
  }
  selectSpectator(value, offset = null) {
    if (!this.raw) return;
    const owner = this.raw.players.find(entry => entry.ownerId === this.playerId);
    const me = this.raw.standings.find(entry => entry.ownerId === this.playerId);
    if (!me || me.lives > 0) return;
    const args = [this.raw.cells, this.raw.standings, owner?.team, this.raw.bounds];
    if (offset !== null) this.spectator.cycle(offset, ...args);
    else this.spectator.select(value, ...args);
  }

  close() {
    this.manualClose = true;
    this.cancelReconnect();
    this.stopHeartbeat();
    if (this.room) {
      this.stop();
      this.send({ type: "leave" });
    }
    const socket = this.socket;
    this.socket = null; this.connection = "idle";
    this.finishConnection?.(new Error("已离开联机。"));
    this.stopPending = false;
    try { socket?.close(); } catch { /* 主动离开不等待网络恢复。 */ }
  }

  /** 接收的真实质量不插值，只有绘制坐标缓动；新 ID（复活、分裂）直接出现。 */
  step(dt, input) {
    this.checkConnection();
    const observing = this.raw?.standings?.find(entry => entry.ownerId === this.playerId)?.lives <= 0;
    if (observing) this.spectator.pan(input, dt, this.raw.bounds);
    const active = this.state === 'playing' && !this.inactive && !observing && this.connection === 'connected';
    const transportReady = this.socket?.readyState === 1 && this.socket.bufferedAmount <= 128 * 1024;
    if (!active || !transportReady || this.now() - this.stateReceivedAt > 400) this.prediction.reset();
    const movement = active && transportReady ? this.prediction.advance(dt, input, this.seq) : new Map();
    if (this.raw) {
      const alpha = 1 - Math.exp(-38 * dt);
      const age = this.stateReceivedAt ? Math.min(.12, Math.max(0, (this.now() - this.stateReceivedAt) / 1000)) : 0;
      for (const cell of this.raw.cells) {
        const position = this.positions.get(cell.id);
        if (!position) continue;
        const own = cell.ownerId === this.playerId;
        const predicted = own && this.prediction.enabled ? this.prediction.cells.get(cell.id) : null;
        const delta = movement.get(cell.id);
        // 输入位移立即显示；仅将权威校正产生的误差平滑回收，避免每帧再增加追随延迟。
        if (delta) { position.x += delta.x; position.y += delta.y; }
        const target = cell.ownerId === this.playerId
          ? predicted ?? { x: cell.x + Number(cell.vx || 0) * (active ? age : 0), y: cell.y + Number(cell.vy || 0) * (active ? age : 0) }
          : this.positionBuffer.sample(cell, this.now());
        const predictedX = Math.max(cell.radius, Math.min(this.raw.bounds.width - cell.radius, target.x));
        const predictedY = Math.max(cell.radius, Math.min(this.raw.bounds.height - cell.radius, target.y));
        if (Math.hypot(predictedX - position.x, predictedY - position.y) > 450) Object.assign(position, { x: cell.x, y: cell.y });
        else {
          const smoothing = own && cell.motion ? 1 - Math.exp(-12 * dt) : alpha;
          position.x += (predictedX - position.x) * smoothing; position.y += (predictedY - position.y) * smoothing;
        }
      }
    }
    if (this.state === "playing" && !this.inactive && !observing) {
      this.queued.split ||= Boolean(input.split);
      this.queued.spore ||= Boolean(input.spore);
      const actionPressed = (input.split && !this.lastActions.split) || (input.spore && !this.lastActions.spore) ||
        Boolean(input.sporeHeld) !== Boolean(this.lastActions.sporeHeld) || Boolean(input.regroup) !== Boolean(this.lastActions.regroup);
      this.lastActions = { split: Boolean(input.split), spore: Boolean(input.spore), sporeHeld: Boolean(input.sporeHeld), regroup: Boolean(input.regroup) };
      this.sendTimer += dt;
      // 技能按下立即发送；普通移动维持 30Hz，卡顿后不补发一串过期输入。
      if (this.sendTimer >= 1 / 30 || actionPressed) {
        this.sendTimer = 0;
        if (this.send({ type: "input", roundId: this.roundId, seq: this.seq, x: input.x, y: input.y,
          target: input.target, split: this.queued.split, spore: this.queued.spore, sporeHeld: Boolean(input.sporeHeld), regroup: Boolean(input.regroup) })) {
          this.queued = { split: false, spore: false };
          this.seq++;
        }
      }
    }
    const events = this.events;
    this.events = [];
    return events;
  }

  getSnapshot() {
    const networkOwner = this.raw?.players?.find(entry => entry.ownerId === this.playerId);
    const age = this.stateReceivedAt ? Math.max(0, (this.now() - this.stateReceivedAt) / 1000) : null;
    const pendingInputs = this.state === "playing" && networkOwner && Number.isInteger(networkOwner.ack) ? Math.max(0, this.seq - 1 - networkOwner.ack) : 0;
    const now = this.now();
    const downloadKBps = this.traffic.reduce((bytes, sample) => now - sample.time < 1000 ? bytes + sample.bytes : bytes, 0) / 1024;
    const network = { connection: this.connection, error: this.error, room: this.room, playerId: this.playerId,
      customRecord: this.customRecord ?? this.room?.customRecord ?? null,
      rtt: this.rtt, inactive: this.inactive, stateAge: age, pendingInputs, downloadKBps,
      predictionActive: this.prediction.enabled, predictionMs: Math.round(this.prediction.seconds * 1000),
      jitter: Math.round(this.positionBuffer.jitter), interpolationDelay: Math.round(this.positionBuffer.delay * 1000),
      quality: this.connection === "reconnecting" ? "reconnecting" : this.connection !== "connected" ? "offline" : this.state === "playing" && age !== null && age > .5 ? "poor" : this.rtt === null ? "unknown" : this.rtt <= 80 && pendingInputs <= 2 ? "good" : this.rtt <= 180 && pendingInputs <= 6 ? "fair" : "poor" };
    if (!this.raw) return { ...this.placeholder, state: "ready", network };
    const raw = this.raw;
    const owner = raw.players.find(owner => owner.ownerId === this.playerId);
    const teamMode = raw.rules?.mode === "teams";
    const teamStandings = (raw.teams || []).map(team => ({ ...team, isPlayer: team.id === owner.team }));
    const myTeam = teamStandings.find(team => team.isPlayer);
    const cells = raw.cells.map(cell => ({ ...cell, ...this.positions.get(cell.id), isPlayer: cell.ownerId === this.playerId,
      isAlly: teamMode && cell.ownerId !== this.playerId && cell.team === owner.team }));
    const playerCells = cells.filter(cell => cell.isPlayer);
    const opponents = cells.filter(cell => !cell.isPlayer);
    const standings = raw.standings.map(entry => ({ ...entry, movement: this.rankMovement.get(entry.ownerId) ?? 0, isPlayer: entry.ownerId === this.playerId }));
    const me = standings.find(entry => entry.isPlayer);
    const followed = cells.reduce((largest, cell) => !largest || cell.mass > largest.mass ? cell : largest, null);
    const fallback = followed ?? this.placeholder.player;
    const player = summarizeCells(playerCells, fallback);
    const spectating = me.lives <= 0;
    const cameraTarget = spectating ? this.spectator.target(cells, standings, owner.team, raw.bounds) : player;
    const choices = this.spectator.choices(standings, owner.team);
    const winners = (teamMode ? teamStandings : standings).filter(entry => entry.rank === 1).map(entry => entry.name);
    return {
      network, mode: "survival", state: this.state, spectating, cameraTarget,
      spectator: spectating ? { mode: this.spectator.mode, ownerId: this.spectator.ownerId, choices } : null,
      team: teamMode ? { ...myTeam, standings: teamStandings } : null,
      teamBots: teamMode ? raw.players.filter(p => p.team === owner.team && p.isBot && standings.some(s => s.ownerId === p.ownerId && s.lives > 0))
        .map(p => ({ name: p.name, action: p.teamAction ?? '' })) : [],
      bounds: raw.bounds, player, playerCells, bots: opponents, foods: this.foods, spores: raw.spores || [], spikes: raw.spikes || [],
      score: owner.score, elapsed: raw.elapsed, eatenBalls: owner.eatenBalls, killer: owner.killer,
      protectionRemaining: raw.protectionByOwner[this.playerId] ?? 0,
      stats: owner.stats ?? null, practice: null, regrouping: Boolean(owner.regrouping && !this.inactive),
      sprint: owner.sprint, split: owner.split, spore: owner.spore, stage: getStage(owner.score),
      difficulty: getDifficulty(owner.score, owner.peakMass, raw.elapsed), peakMass: owner.peakMass,
      hotspots: raw.hotspots,
      safeZone: raw.safeZone ? { ...raw.safeZone, exposure: owner.zoneExposure ?? 0 } : null,
      pings: (raw.pings || []).filter(item => item.expiresAt > raw.elapsed), pingCooldown: owner.pingCooldown ?? 0,
      leaderboard: { kind: "survival", entries: standings.slice(0, 5), player: me, total: standings.length },
      survival: { duration: raw.duration, remaining: Math.max(0, raw.duration - raw.elapsed), player: me,
        active: standings.filter(entry => !entry.eliminated).length, total: standings.length, standings,
        protectionByOwner: raw.protectionByOwner },
      result: raw.finished ? { reason: !teamMode && me.lives <= 0 ? "eliminated" : raw.reason,
        rank: teamMode ? myTeam.rank : me.rank, teamMode,
        lives: me.lives, kills: me.kills, deaths: me.deaths,
        won: teamMode ? myTeam.rank === 1 && myTeam.active > 0 : me.lives > 0 && me.rank === 1, winners } : null,
    };
  }
}
