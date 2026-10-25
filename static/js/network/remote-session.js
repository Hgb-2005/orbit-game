import { summarizeCells } from "../core/cells.js";
import { getDifficulty, getStage } from "../core/progression.js";

/** 远程会话只发送输入和读取快照，永不在客户端计算吞噬、生命或分数。 */
export class RemoteSession {
  constructor(placeholder, onChange = () => {}, socketFactory = url => new WebSocket(url)) {
    this.placeholder = placeholder;
    this.onChange = onChange;
    this.socketFactory = socketFactory;
    this.socket = null;
    this.playerId = "";
    this.resumeToken = "";
    this.room = null;
    this.raw = null;
    this.foods = [];
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
    this.pingTimer = 0;
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
        if (message.type === "welcome") {
          if (resume && resumeToken) {
            this.resumePending = true;
            // 此时连接状态仍是 reconnecting，不能走只允许 connected 的普通输入通道。
            if (socket.readyState === 1 && socket.bufferedAmount <= 128 * 1024) {
              socket.send(JSON.stringify({ type: "resume", token: resumeToken }));
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
        this.socket = null;
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
    this.socket.send(JSON.stringify(message));
    return true;
  }

  async enter(type, name, code) {
    try {
      this.manualClose = false;
      this.cancelReconnect();
      await this.connect();
      this.error = "";
      this.send({ type, name: name.trim(), code: code?.trim() });
    } catch (error) { this.error = error.message; }
    this.onChange();
  }

  receive(message) {
    if (message.type === "resumed") {
      this.playerId = message.playerId || this.playerId;
      this.resumePending = false;
      this.connection = "connected";
      this.error = "";
      this.reconnectAttempt = 0;
      this.inactive = !this.resumeInputAfterReconnect;
      this.events.push({ type: "networkresume" });
      this.finishConnection?.();
      this.onChange();
    } else if (message.type === "room") {
      this.room = message;
      if (message.state === "waiting") {
        this.raw = null; this.state = "ready"; this.positions.clear(); this.events = [];
        this.roundId = ""; this.eventCursor = 0; this.seq = 0; this.stateReceivedAt = 0; this.previousRanks.clear(); this.rankMovement.clear();
      }
      this.error = ""; this.onChange();
    } else if (message.type === "left") {
      this.room = null; this.raw = null; this.state = "ready"; this.roundId = "";
      this.positions.clear(); this.events = []; this.stateReceivedAt = 0; this.previousRanks.clear(); this.rankMovement.clear(); this.error = ""; this.onChange();
    } else if (message.type === "error") {
      this.error = message.message;
      if (this.resumePending) {
        this.resumePending = false;
        this.socket?.close();
      }
      this.onChange();
    } else if (message.type === "record_saved") {
      this.events.push({ type: "record_saved" });
    } else if (message.type === "pong") {
      if (Number.isFinite(message.sent)) this.rtt = Math.max(0, Math.round(performance.now() - message.sent));
    } else if (message.type === "foods" && message.roundId === this.room?.roundId) {
      this.foods = message.foods;
    } else if (message.type === "state" && this.room && this.room.state !== "waiting" && message.roundId === this.room.roundId) {
      const newRound = this.roundId !== message.roundId;
      if (newRound) {
        this.roundId = message.roundId; this.eventCursor = 0; this.seq = 0;
        this.positions.clear(); this.previousRanks.clear(); this.rankMovement.clear(); this.events = [{ type: "networkstart" }];
        this.sendTimer = .05; this.queued = { split: false, spore: false }; this.inactive = false;
      }
      this.raw = message.world;
      this.stateReceivedAt = performance.now();
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
    this.inactive = true;
    this.queued = { split: false, spore: false };
    this.send({ type: "stop" });
  }

  resumeInput() { this.inactive = false; }
  leave() {
    this.manualClose = true;
    this.cancelReconnect();
    this.stop();
    this.send({ type: "leave" });
  }
  ready(value) { this.send({ type: "ready", ready: value }); }
  start() { this.send({ type: "start" }); }
  rematch() { this.send({ type: "rematch" }); }

  close() {
    this.manualClose = true;
    this.cancelReconnect();
    if (this.room) {
      this.stop();
      this.send({ type: "leave" });
    }
    const socket = this.socket;
    this.socket = null; this.connection = "idle";
    socket?.close();
  }

  /** 接收的真实质量不插值，只有绘制坐标缓动；新 ID（复活、分裂）直接出现。 */
  step(dt, input) {
    if (this.raw) {
      const alpha = 1 - Math.exp(-38 * dt);
      const age = this.stateReceivedAt ? Math.min(.12, Math.max(0, (performance.now() - this.stateReceivedAt) / 1000)) : 0;
      for (const cell of this.raw.cells) {
        const position = this.positions.get(cell.id);
        if (!position) continue;
        // 用服务器速度做最多 120ms 的视觉外推，减少 15～20Hz 快照之间的停顿；
        // 下一份权威快照到达后仍会快速校正，质量和规则始终来自服务器。
        const predictedX = cell.x + Number(cell.vx || 0) * age;
        const predictedY = cell.y + Number(cell.vy || 0) * age;
        if (Math.hypot(predictedX - position.x, predictedY - position.y) > 450) Object.assign(position, { x: cell.x, y: cell.y });
        else { position.x += (predictedX - position.x) * alpha; position.y += (predictedY - position.y) * alpha; }
      }
    }
    if (this.state === "playing" && !this.inactive) {
      this.queued.split ||= Boolean(input.split);
      this.queued.spore ||= Boolean(input.spore);
      this.sendTimer += dt;
      if (this.sendTimer >= 1 / 30) {
        this.sendTimer -= 1 / 30;
        if (this.send({ type: "input", roundId: this.roundId, seq: this.seq++, x: input.x, y: input.y,
          target: input.target, split: this.queued.split, spore: this.queued.spore })) {
          this.queued = { split: false, spore: false };
        }
      }
    }
    this.pingTimer += dt;
    if (this.pingTimer >= 3) { this.pingTimer = 0; this.send({ type: "ping", sent: performance.now() }); }
    const events = this.events;
    this.events = [];
    return events;
  }

  getSnapshot() {
    const networkOwner = this.raw?.players?.find(entry => entry.ownerId === this.playerId);
    const age = this.stateReceivedAt ? Math.max(0, (performance.now() - this.stateReceivedAt) / 1000) : null;
    const pendingInputs = networkOwner && Number.isInteger(networkOwner.ack) ? Math.max(0, this.seq - 1 - networkOwner.ack) : 0;
    const network = { connection: this.connection, error: this.error, room: this.room, playerId: this.playerId,
      rtt: this.rtt, inactive: this.inactive, stateAge: age, pendingInputs,
      quality: this.connection === "reconnecting" ? "reconnecting" : this.connection !== "connected" ? "offline" : this.rtt === null ? "unknown" : this.rtt <= 80 && pendingInputs <= 2 ? "good" : this.rtt <= 180 && pendingInputs <= 6 ? "fair" : "poor" };
    if (!this.raw) return { ...this.placeholder, state: "ready", network };
    const raw = this.raw;
    const cells = raw.cells.map(cell => ({ ...cell, ...this.positions.get(cell.id), isPlayer: cell.ownerId === this.playerId }));
    const playerCells = cells.filter(cell => cell.isPlayer);
    const opponents = cells.filter(cell => !cell.isPlayer);
    const owner = raw.players.find(owner => owner.ownerId === this.playerId);
    const standings = raw.standings.map(entry => ({ ...entry, movement: this.rankMovement.get(entry.ownerId) ?? 0, isPlayer: entry.ownerId === this.playerId }));
    const me = standings.find(entry => entry.isPlayer);
    const followed = cells.reduce((largest, cell) => !largest || cell.mass > largest.mass ? cell : largest, null);
    const fallback = followed ?? this.placeholder.player;
    const player = summarizeCells(playerCells, fallback);
    const winners = standings.filter(entry => entry.rank === 1).map(entry => entry.name);
    return {
      network, mode: "survival", state: this.state, spectating: me.lives <= 0,
      bounds: raw.bounds, player, playerCells, bots: opponents, foods: this.foods, spores: raw.spores || [], spikes: raw.spikes || [],
      score: owner.score, elapsed: raw.elapsed, eatenBalls: owner.eatenBalls, killer: owner.killer,
      protectionRemaining: raw.protectionByOwner[this.playerId] ?? 0,
      sprint: owner.sprint, split: owner.split, spore: owner.spore, stage: getStage(owner.score),
      difficulty: getDifficulty(owner.score, owner.peakMass, raw.elapsed), peakMass: owner.peakMass,
      hotspots: raw.hotspots,
      leaderboard: { kind: "survival", entries: standings.slice(0, 5), player: me, total: standings.length },
      survival: { duration: raw.duration, remaining: Math.max(0, raw.duration - raw.elapsed), player: me,
        active: standings.filter(entry => !entry.eliminated).length, total: standings.length, standings,
        protectionByOwner: raw.protectionByOwner },
      result: raw.finished ? { reason: me.lives <= 0 ? "eliminated" : raw.reason, rank: me.rank,
        lives: me.lives, kills: me.kills, deaths: me.deaths, won: me.lives > 0 && me.rank === 1, winners } : null,
    };
  }
}
