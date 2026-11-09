/**
 * 可选的音频频谱采样器。背景音乐通过 AnalyserNode 的旁路连接读取，
 * 不会改变原有音量、回声或暂停逻辑；麦克风只在用户明确开启后申请权限。
 */
export class VisualAudioAnalyser {
  constructor() {
    this.music = null;
    this.musicAnalyser = null;
    this.musicFrequency = null;
    this.musicSource = null;
    this.microphoneAnalyser = null;
    this.microphoneFrequency = null;
    this.microphoneSource = null;
    this.microphoneContext = null;
    this.stream = null;
    this.microphoneEnabled = false;
    this.level = 0;
    this.bass = 0;
    this.mid = 0;
  }

  connectMusic(music) {
    this.music = music;
    const context = music?.context;
    const source = music?.mix;
    if (!context || !source || context.state === "closed") return false;
    if (this.musicAnalyser && this.musicSource === source) return true;
    this.disconnectMusic();
    this.musicSource = source;
    this.musicAnalyser = context.createAnalyser();
    this.musicAnalyser.fftSize = 256;
    this.musicAnalyser.smoothingTimeConstant = .78;
    this.musicFrequency = new Uint8Array(this.musicAnalyser.frequencyBinCount);
    source.connect(this.musicAnalyser);
    return true;
  }

  async setMicrophone(enabled, audioContext) {
    if (!enabled) {
      this.disconnectMicrophone();
      return false;
    }
    if (!audioContext || !globalThis.navigator?.mediaDevices?.getUserMedia) throw new Error("当前浏览器不支持麦克风频谱");
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    try {
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = .82;
      source.connect(analyser);
      this.disconnectMicrophone();
      this.stream = stream;
      this.microphoneSource = source;
      this.microphoneAnalyser = analyser;
      this.microphoneFrequency = new Uint8Array(analyser.frequencyBinCount);
      this.microphoneContext = audioContext;
      this.microphoneEnabled = true;
    } catch (error) {
      stream.getTracks?.().forEach(track => track.stop());
      throw error;
    }
    return true;
  }

  sample() {
    if (this.music && !this.musicAnalyser) this.connectMusic(this.music);
    const music = this.readAnalyser(this.musicAnalyser, this.musicFrequency);
    const microphone = this.readAnalyser(this.microphoneAnalyser, this.microphoneFrequency);
    const values = [music, microphone].filter(Boolean);
    if (!values.length) return this.snapshot();
    const blend = values.length === 2
      ? { bass: music.bass * .72 + microphone.bass * .28,
        mid: music.mid * .72 + microphone.mid * .28,
        level: music.level * .72 + microphone.level * .28 }
      : values[0];
    // 独立平滑，避免帧率差异让光晕在浏览器之间闪烁得不同。
    this.level += (blend.level - this.level) * .18;
    this.bass += (blend.bass - this.bass) * .2;
    this.mid += (blend.mid - this.mid) * .16;
    return this.snapshot();
  }

  readAnalyser(analyser, frequency) {
    if (!analyser || !frequency) return null;
    analyser.getByteFrequencyData(frequency);
    const bucket = (from, to) => {
      let total = 0;
      for (let index = from; index < Math.min(to, frequency.length); index++) total += frequency[index];
      return total / Math.max(1, Math.min(to, frequency.length) - from) / 255;
    };
    const bass = bucket(1, 8);
    const mid = bucket(8, 32);
    const treble = bucket(32, 80);
    const level = Math.max(0, Math.min(1, bass * .48 + mid * .36 + treble * .16));
    return { bass, mid, level };
  }

  snapshot() {
    return { level: this.level, bass: this.bass, mid: this.mid, microphone: this.microphoneEnabled };
  }

  disconnectMusic() {
    try { this.musicSource?.disconnect?.(this.musicAnalyser); } catch { /* 音频节点可能已被关闭。 */ }
    this.musicAnalyser = null;
    this.musicFrequency = null;
    this.musicSource = null;
  }

  disconnectMicrophone() {
    try { this.microphoneSource?.disconnect?.(); } catch { /* 音频节点可能已被关闭。 */ }
    this.stream?.getTracks?.().forEach(track => track.stop());
    this.microphoneAnalyser = null;
    this.microphoneFrequency = null;
    this.microphoneSource = null;
    this.stream = null;
    this.microphoneContext = null;
    this.microphoneEnabled = false;
  }

  disconnect() {
    this.disconnectMusic();
    this.disconnectMicrophone();
    this.music = null;
  }
}
