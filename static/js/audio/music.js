import { CONFIG } from "../config.js";

// 原创的八小节五声音阶旋律。null 留出呼吸，音高使用 MIDI 编号，方便改曲。
const MELODY = [
  [72, null, 76, 79, null, 76, 74, null],
  [72, null, 69, null, 76, null, 74, 72],
  [69, null, 72, 76, null, 72, 69, null],
  [67, null, 74, null, 79, 76, 74, null],
  [76, null, 79, 81, null, 79, 76, null],
  [76, 72, null, 69, null, 72, 74, null],
  [72, null, 76, null, 79, 76, 72, null],
  [74, null, 69, null, 67, null, 72, null],
];
const HARMONY = [
  { bass: 48, notes: [60, 64, 67] }, { bass: 45, notes: [60, 64, 69] },
  { bass: 41, notes: [57, 60, 64] }, { bass: 43, notes: [59, 62, 67] },
];

function browserStorage() {
  try { return globalThis.localStorage; } catch { return null; }
}

/**
 * 音频属于表现层，不进入 World 和快照，方便多人版复用。
 * 使用 Web Audio 合成旋律、和弦与低音，无需下载音乐文件或引入第三方库。
 * 平台依赖可注入，以验证浏览器手势限制和暂停/重开时的异步竞争。
 */
export class BackgroundMusic {
  constructor(onChange = () => {}, options = {}) {
    const Context = globalThis.AudioContext ?? globalThis.webkitAudioContext;
    this.createContext = options.createContext ?? (Context ? () => new Context() : null);
    this.storage = options.storage === undefined ? browserStorage() : options.storage;
    this.setTimer = options.setTimer ?? ((callback, interval) => setInterval(callback, interval));
    this.clearTimer = options.clearTimer ?? (timer => clearInterval(timer));
    this.onChange = onChange;
    this.supported = Boolean(this.createContext);
    this.enabled = true;
    this.volume = CONFIG.music.defaultVolume;
    try {
      this.enabled = this.storage?.getItem("orbit.music") !== "off";
      const stored = this.storage?.getItem("orbit.music-volume");
      if (stored !== null && stored !== undefined && stored.trim() !== "") {
        const volume = Number(stored);
        if (Number.isFinite(volume)) this.volume = Math.max(0, Math.min(1, volume));
      }
    } catch { /* 存储不可用时仍能在本次游戏中调节。 */ }
    this.gameState = "ready";
    this.context = null;
    this.master = null;
    this.mix = null;
    this.timer = null;
    this.resumeTask = null;
    this.voices = new Set();
    this.stepIndex = 0;
    this.nextNoteTime = 0;
    this.blocked = false;
    this.disposed = false;
  }

  get wantsPlayback() {
    return !this.disposed && this.supported && this.enabled && this.volume > 0 && this.gameState === "playing";
  }

  getSnapshot() {
    return {
      supported: this.supported, enabled: this.enabled, volume: this.volume,
      playing: this.timer !== null && this.context?.state === "running", blocked: this.blocked,
    };
  }

  notify() {
    this.onChange(this.getSnapshot());
  }

  save(key, value) {
    try { this.storage?.setItem(key, String(value)); } catch { /* 记忆失败不影响播放。 */ }
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    this.save("orbit.music", this.enabled ? "on" : "off");
    this.syncPlayback();
  }

  setVolume(volume) {
    if (!Number.isFinite(volume)) return;
    this.volume = Math.max(0, Math.min(1, volume));
    this.save("orbit.music-volume", this.volume);
    this.syncPlayback();
  }

  setGameState(state, { restart = false } = {}) {
    if (restart) {
      this.stopPlayback();
      this.stepIndex = 0;
    }
    this.gameState = state;
    this.syncPlayback();
  }

  /** 必须从开始/继续游戏、音乐开关或音量输入等用户操作中同步调用。 */
  unlock({ force = false } = {}) {
    // 音效可借用同一个 AudioContext；背景音乐关闭时也允许在用户手势中解锁。
    if (this.disposed || !this.supported || (!this.wantsPlayback && !force)) return Promise.resolve(false);
    if (this.resumeTask) return this.resumeTask;
    try {
      if (!this.context) this.createGraph();
      // resume 直接在手势回调内调用，不能推迟到 rAF 或网络请求之后。
      const result = this.context.state === "running" ? undefined : this.context.resume();
      this.resumeTask = Promise.resolve(result).then(() => {
        this.blocked = this.context.state !== "running";
        // resume 返回时可能已经暂停/关闭音乐，以最新意图为准。
        this.syncPlayback();
        return this.wantsPlayback && !this.blocked;
      }).catch(() => {
        this.blocked = true;
        this.stopPlayback();
        this.notify();
        return false;
      }).finally(() => { this.resumeTask = null; });
      return this.resumeTask;
    } catch {
      this.blocked = true;
      this.stopPlayback();
      this.notify();
      return Promise.resolve(false);
    }
  }

  createGraph() {
    this.context = this.createContext();
    const context = this.context;
    this.master = context.createGain();
    this.master.gain.value = 0;
    this.master.connect(context.destination);
    this.mix = context.createBiquadFilter();
    this.mix.type = "lowpass";
    this.mix.frequency.value = 1800;
    this.mix.Q.value = 0.5;
    this.mix.connect(this.master);
    // 一个无反馈的短回声提供空间感，不会无限堆叠或产生失控增益。
    this.echo = context.createDelay(1);
    this.echo.delayTime.value = 0.24;
    this.echoGain = context.createGain();
    this.echoGain.gain.value = 0.14;
    this.mix.connect(this.echo);
    this.echo.connect(this.echoGain);
    this.echoGain.connect(this.master);
    context.onstatechange = () => {
      if (!this.disposed) this.syncPlayback();
    };
  }

  syncPlayback() {
    if (!this.wantsPlayback || this.context?.state !== "running") {
      this.stopPlayback();
    } else {
      const now = this.context.currentTime;
      this.master.gain.cancelScheduledValues(now);
      this.master.gain.setTargetAtTime(this.volume * CONFIG.music.outputGain, now, 0.04);
      if (this.timer === null) {
        this.nextNoteTime = now + 0.04;
        this.scheduleNotes();
        this.timer = this.setTimer(() => this.scheduleNotes(), CONFIG.music.timerInterval);
      }
    }
    this.notify();
  }

  stopPlayback() {
    if (this.timer !== null) this.clearTimer(this.timer);
    this.timer = null;
    if (!this.context || !this.master) return;
    const now = this.context.currentTime;
    this.master.gain.cancelScheduledValues(now);
    this.master.gain.setTargetAtTime(0, now, 0.02);
    // 淡出后停止所有已安排的振荡器，切后台不会继续消耗音符与定时器。
    for (const voice of this.voices) {
      try { voice.stop(now + 0.12); } catch { /* 已自然结束的音符无需再次停止。 */ }
    }
  }

  scheduleNotes() {
    if (!this.wantsPlayback || this.context?.state !== "running") return;
    const now = this.context.currentTime;
    const stepDuration = 60 / CONFIG.music.tempo / 2;
    // 后台计时器被节流时跳过落后的时间，恢复后不密集补播漏掉的音符。
    if (this.nextNoteTime < now - 0.1) this.nextNoteTime = now + 0.04;
    while (this.nextNoteTime < now + CONFIG.music.lookAhead) {
      const bar = Math.floor(this.stepIndex / 8);
      const beat = this.stepIndex % 8;
      const time = this.nextNoteTime;
      const note = MELODY[bar][beat];
      if (note !== null) this.playTone(note, time, stepDuration * 1.65, 0.22, "triangle", 0.015);
      if (beat === 0) {
        const chord = HARMONY[bar % HARMONY.length];
        for (const pitch of chord.notes) this.playTone(pitch, time, stepDuration * 8.8, 0.05, "sine", 0.55);
        this.playTone(chord.bass, time, stepDuration * 5, 0.16, "sine", 0.06);
      }
      this.stepIndex = (this.stepIndex + 1) % (MELODY.length * 8);
      this.nextNoteTime += stepDuration;
    }
  }

  playTone(note, time, duration, volume, type, attack) {
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    oscillator.type = type;
    oscillator.frequency.setValueAtTime(440 * 2 ** ((note - 69) / 12), time);
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(volume, time + attack);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration);
    oscillator.connect(envelope);
    envelope.connect(this.mix);
    this.voices.add(oscillator);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
      this.voices.delete(oscillator);
    };
    oscillator.start(time);
    oscillator.stop(time + duration + 0.03);
  }

  dispose() {
    this.disposed = true;
    this.stopPlayback();
    if (this.context) {
      this.context.onstatechange = null;
      void this.context.close().catch(() => {});
    }
    this.notify();
  }
}
