import { CONFIG } from "../config.js";

const PRIORITY = ["celllost", "eat", "spike", "split", "spore", "spore-eat", "sprint", "merge", "food"];
const INTERVALS = { celllost: 0.25, eat: 0.18, spike: 0.35, split: 0.2, spore: 0.2, "spore-eat": 0.18, sprint: 0.3, merge: 0.25 };
const CUES = {
  food: [{ note: 76, duration: 0.075, gain: 0.1 }],
  eat: [{ note: 64, duration: 0.14, gain: 0.17 }, { note: 72, delay: 0.045, duration: 0.14, gain: 0.14 }, { note: 79, delay: 0.09, duration: 0.12, gain: 0.1 }],
  split: [{ note: 67, endNote: 79, duration: 0.14, gain: 0.16 }],
  spore: [{ note: 70, endNote: 58, duration: 0.12, gain: 0.11 }],
  "spore-eat": [{ note: 83, duration: 0.08, gain: 0.08 }],
  spike: [{ note: 52, endNote: 40, duration: 0.28, gain: 0.15 }],
  merge: [{ note: 67, duration: 0.18, gain: 0.14 }, { note: 72, delay: 0.07, duration: 0.2, gain: 0.12 }],
  sprint: [{ note: 72, endNote: 84, duration: 0.1, gain: 0.1 }],
  celllost: [{ note: 64, endNote: 55, duration: 0.18, gain: 0.14 }],
};

/** 与背景音乐共用音频设备，但使用独立音量总线和开关；不保存或重放旧事件。 */
export class SoundEffects {
  constructor(getContext, onChange = () => {}, options = {}) {
    this.getContext = getContext;
    this.onChange = onChange;
    this.supported = options.supported ?? true;
    this.storage = null;
    try { this.storage = options.storage === undefined ? globalThis.localStorage : options.storage; } catch { /* 不依赖存储权限。 */ }
    this.enabled = true;
    try { this.enabled = this.storage?.getItem("orbit.effects") !== "off"; } catch { /* 本次仍可开关音效。 */ }
    this.state = "ready";
    this.master = null;
    this.context = null;
    this.voices = new Set();
    this.nextAllowed = new Map();
    this.nextGlobal = 0;
    this.foodPitch = 0;
  }

  getSnapshot() {
    return { enabled: this.enabled, supported: this.supported };
  }

  setEnabled(enabled) {
    this.enabled = Boolean(enabled);
    try { this.storage?.setItem("orbit.effects", this.enabled ? "on" : "off"); } catch { /* 开关仍生效。 */ }
    if (!this.enabled) this.stopAll();
    this.onChange(this.getSnapshot());
  }

  setGameState(state, { restart = false } = {}) {
    this.state = state;
    if (state !== "playing" || restart) this.stopAll();
    if (restart) {
      this.nextAllowed.clear();
      this.nextGlobal = 0;
      this.foodPitch = 0;
    }
  }

  handleEvents(events) {
    const context = this.getContext();
    if (!this.supported || !this.enabled || this.state !== "playing" || context?.state !== "running") return null;
    const now = context.currentTime;
    if (now < this.nextGlobal || this.voices.size >= CONFIG.effects.maxVoices) return null;
    // 一次更新只选一个提示：吞噬/技能优先于食物，连吃食物也不会堆叠成噪声。
    const kinds = new Set(events.map(event => event.type));
    const type = PRIORITY.find(kind => kinds.has(kind) && now >= (this.nextAllowed.get(kind) ?? 0));
    if (!type) return null;
    if (!this.master || this.context !== context) {
      this.context = context;
      this.master = context.createGain();
      this.master.gain.value = CONFIG.effects.volume;
      this.master.connect(context.destination);
    }
    for (const tone of CUES[type]) {
      if (this.voices.size >= CONFIG.effects.maxVoices) break;
      const offset = type === "food" ? [0, 3, 5][this.foodPitch++ % 3] : 0;
      this.playTone({ ...tone, note: tone.note + offset }, now + (tone.delay ?? 0));
    }
    this.nextGlobal = now + CONFIG.effects.globalInterval;
    this.nextAllowed.set(type, now + (type === "food" ? CONFIG.effects.foodInterval : INTERVALS[type]));
    return type;
  }

  playTone(tone, time) {
    const oscillator = this.context.createOscillator();
    const envelope = this.context.createGain();
    const frequency = note => 440 * 2 ** ((note - 69) / 12);
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency(tone.note), time);
    if (tone.endNote) oscillator.frequency.exponentialRampToValueAtTime(frequency(tone.endNote), time + tone.duration);
    envelope.gain.setValueAtTime(0, time);
    envelope.gain.linearRampToValueAtTime(tone.gain, time + 0.006);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + tone.duration);
    oscillator.connect(envelope);
    envelope.connect(this.master);
    const voice = { oscillator, envelope };
    this.voices.add(voice);
    oscillator.onended = () => {
      oscillator.disconnect();
      envelope.disconnect();
      this.voices.delete(voice);
    };
    oscillator.start(time);
    oscillator.stop(time + tone.duration + 0.02);
  }

  stopAll() {
    if (!this.context) return;
    const now = this.context.currentTime;
    for (const { oscillator, envelope } of this.voices) {
      envelope.gain.cancelScheduledValues(now);
      envelope.gain.setTargetAtTime(0, now, 0.006);
      try { oscillator.stop(now + 0.035); } catch { /* 已结束音符由 onended 回收。 */ }
    }
  }
}
