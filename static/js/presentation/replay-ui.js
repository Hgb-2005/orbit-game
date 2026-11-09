import { Camera } from "../camera.js";
import { Renderer } from "../renderer.js";
import { frameIndexAt, ReplayPlayer } from "../replay/player.js";

const fmtTime = seconds => {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
};

const fmtBytes = bytes => {
  const value = Math.max(0, Number(bytes) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(2)} MB`;
};

const fmtDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "时间未知" : date.toLocaleString("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
  });
};

const safeFilename = value => String(value || "orbit-replay")
  .replace(/[\\/:*?"<>|]+/g, "-")
  .replace(/\s+/g, "-")
  .slice(0, 64);

const downloadBlob = (blob, filename) => {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

/**
 * 回放界面拥有独立 Canvas、相机与 Renderer。它只读取 ReplayPlayer
 * 重建出的只读快照，因此打开录像不会暂停真实世界之外产生任何副作用。
 */
export class ReplayUI {
  constructor(storage, { onOpen = () => {}, onClose = () => {}, toast = () => {} } = {}) {
    this.storage = storage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.toast = toast;
    this.dialog = document.getElementById("replay-dialog");
    this.canvas = document.getElementById("replay-canvas");
    this.list = document.getElementById("replay-list");
    this.empty = document.getElementById("replay-empty");
    this.badge = document.getElementById("replay-badge");
    this.records = [];
    this.selectedId = "";
    this.player = null;
    this.playerIndex = -1;
    this.camera = new Camera();
    this.renderer = null;
    this.animationFrame = 0;
    this.lastFrame = 0;
    this.mediaRecorder = null;
    this.videoChunks = [];
    this.cancelVideoExport = false;
    this.bind();
  }

  bind() {
    document.getElementById("replays-open")?.addEventListener("click", () => void this.open());
    document.getElementById("replay-close")?.addEventListener("click", () => this.close());
    document.getElementById("replay-refresh")?.addEventListener("click", () => void this.load());
    document.getElementById("replay-play")?.addEventListener("click", () => this.togglePlayback());
    document.getElementById("replay-back")?.addEventListener("click", () => this.seekBy(-5));
    document.getElementById("replay-forward")?.addEventListener("click", () => this.seekBy(5));
    document.getElementById("replay-progress")?.addEventListener("input", event => {
      if (!this.player) return;
      this.player.pause();
      this.player.seek(Number(event.target.value));
      this.drawCurrent(true);
      this.renderControls();
    });
    document.getElementById("replay-speed")?.addEventListener("change", event => {
      this.player?.setSpeed(event.target.value);
      this.renderControls();
    });
    document.getElementById("replay-screenshot")?.addEventListener("click", () => this.exportPng());
    document.getElementById("replay-video")?.addEventListener("click", () => void this.exportVideo());
    document.getElementById("replay-delete")?.addEventListener("click", () => void this.deleteSelected());
    this.dialog?.addEventListener("keydown", event => {
      if (event.code !== "Space" || /INPUT|SELECT|BUTTON|TEXTAREA/.test(event.target.tagName)) return;
      event.preventDefault();
      this.togglePlayback();
    });
    this.dialog?.addEventListener("cancel", event => {
      event.preventDefault();
      this.close();
    });
    this.dialog?.addEventListener("click", event => {
      if (event.target === this.dialog) this.close();
    });
  }

  async open() {
    if (!this.dialog || this.dialog.open) return;
    this.onOpen();
    this.dialog.showModal();
    await new Promise(resolve => requestAnimationFrame(resolve));
    this.ensureRenderer();
    await this.load();
  }

  close() {
    if (!this.dialog?.open) return;
    this.player?.pause();
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    if (this.mediaRecorder?.state === "recording") {
      this.cancelVideoExport = true;
      this.mediaRecorder.stop();
    }
    this.dialog.close();
    this.onClose();
  }

  ensureRenderer() {
    if (this.renderer) {
      this.renderer.resize();
      return;
    }
    this.renderer = new Renderer(this.canvas, this.camera);
    this.renderer.resize();
  }

  async load() {
    this.setStatus("正在读取录像…");
    try {
      this.records = await this.storage.list();
      const note = this.storage.lastError;
      if (note) this.setStatus(note);
      else this.setStatus(this.records.length
        ? `已保存 ${this.records.length} 盘 · ${fmtBytes(this.records.reduce((sum, item) => sum + (item.size || 0), 0))}`
        : "完成一局后会在这里出现录像。");
      this.renderList();
      const keepCurrent = this.records.some(item => item.id === this.selectedId);
      const nextId = keepCurrent ? this.selectedId : this.records[0]?.id;
      if (nextId) await this.select(nextId);
      else this.clearPlayer("还没有可播放的录像");
    } catch (error) {
      this.records = [];
      this.renderList();
      this.clearPlayer(error instanceof Error ? error.message : "录像读取失败");
      this.setStatus("录像读取失败，请检查浏览器存储权限。");
    }
  }

  async refreshIfOpen() {
    if (this.dialog?.open) await this.load();
  }

  renderList() {
    this.list.replaceChildren();
    this.empty.hidden = this.records.length > 0;
    for (const recording of this.records) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "replay-row";
      button.dataset.id = recording.id;
      button.setAttribute("aria-pressed", String(recording.id === this.selectedId));
      const mode = recording.mode === "survival" ? "生存" : "经典";
      button.innerHTML = `
        <strong>${escapeHtml(recording.title || "微光球场录像")}</strong>
        <span>${escapeHtml(mode)} · ${escapeHtml(recording.mapName || "标准球场")} · ${recording.score || 0} 分</span>
        <small>${escapeHtml(fmtDate(recording.createdAt))} · ${escapeHtml(fmtTime(recording.duration))} · ${escapeHtml(fmtBytes(recording.size))}</small>
      `;
      button.addEventListener("click", () => void this.select(recording.id));
      this.list.append(button);
    }
  }

  async select(id) {
    if (!id) return;
    const recording = await this.storage.get(id);
    if (!recording) {
      this.setStatus("这盘录像已不存在或已经损坏。");
      await this.load();
      return;
    }
    this.selectedId = id;
    this.playerIndex = -1;
    this.player = new ReplayPlayer(recording);
    this.renderList();
    this.renderer?.resetEffects();
    this.renderControls();
    this.drawCurrent(true);
    document.getElementById("replay-name").textContent = recording.title || "微光球场录像";
    document.getElementById("replay-detail").textContent =
      `${recording.source === "server" ? "服务器权威快照" : "单机快照"} · ${recording.frameCount || recording.frames.length} 帧 · ${fmtBytes(recording.size)}`;
    this.setStatus("按空格播放或暂停；拖动时间轴可跳到任意位置。");
  }

  clearPlayer(message) {
    this.player?.pause();
    this.player = null;
    this.playerIndex = -1;
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = 0;
    const context = this.canvas.getContext("2d");
    context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.empty.hidden = false;
    this.empty.querySelector("strong").textContent = message;
    this.renderControls();
  }

  togglePlayback() {
    if (!this.player) return;
    this.player.toggle();
    this.lastFrame = performance.now();
    this.renderControls();
    if (this.player.playing) this.startLoop();
    else cancelAnimationFrame(this.animationFrame);
  }

  seekBy(delta) {
    if (!this.player) return;
    this.player.pause();
    this.player.seek(this.player.currentTime + delta);
    this.drawCurrent(true);
    this.renderControls();
  }

  startLoop() {
    cancelAnimationFrame(this.animationFrame);
    this.lastFrame = performance.now();
    const frame = now => {
      if (document.hidden || !this.dialog?.open || !this.player) return;
      const dt = Math.min(.1, Math.max(0, (now - this.lastFrame) / 1000));
      this.lastFrame = now;
      this.player.advance(dt);
      this.drawCurrent(false, dt);
      this.renderControls();
      if (this.player.playing) this.animationFrame = requestAnimationFrame(frame);
      else {
        this.animationFrame = 0;
        // WebM 导出依赖同一条播放循环；到达片尾时自动封口，避免文件无限增长。
        if (this.mediaRecorder?.state === "recording") this.mediaRecorder.stop();
      }
    };
    this.animationFrame = requestAnimationFrame(frame);
  }

  drawCurrent(snapCamera = false, dt = 0) {
    if (!this.player || !this.renderer) return;
    const snapshot = this.player.getSnapshot();
    if (!snapshot) return;
    const frameIndex = frameIndexAt(this.player.recording.frames, this.player.currentTime);
    if (frameIndex < this.playerIndex) this.renderer.resetEffects();
    const start = Math.max(0, this.playerIndex + 1);
    for (let index = start; index <= frameIndex; index++) {
      this.renderer.addEvents(this.player.recording.frames[index].events || []);
    }
    this.playerIndex = frameIndex;
    this.camera.update(snapshot.cameraTarget ?? snapshot.player, snapshot.bounds,
      this.renderer.width, this.renderer.height, dt, snapCamera);
    this.renderer.aim = null;
    this.renderer.draw(snapshot, dt, { hotspots: {} });
    this.empty.hidden = true;
    this.badge.hidden = snapshot.state !== "gameover";
    if (snapshot.state === "gameover") {
      this.badge.textContent = `对局结束 · ${snapshot.score || 0} 分`;
    }
  }

  renderControls() {
    const ready = Boolean(this.player);
    const progress = document.getElementById("replay-progress");
    const play = document.getElementById("replay-play");
    const speed = document.getElementById("replay-speed");
    for (const id of ["replay-play", "replay-back", "replay-forward", "replay-progress",
      "replay-speed", "replay-screenshot", "replay-video", "replay-delete"]) {
      const element = document.getElementById(id);
      if (element) element.disabled = !ready;
    }
    if (!ready) {
      if (play) play.textContent = "播放";
      if (progress) progress.value = "0";
      document.getElementById("replay-clock").textContent = "00:00 / 00:00";
      return;
    }
    progress.max = String(this.player.duration);
    progress.value = String(this.player.currentTime);
    play.textContent = this.player.playing ? "暂停" : "播放";
    speed.value = String(this.player.speed);
    document.getElementById("replay-clock").textContent =
      `${fmtTime(this.player.currentTime)} / ${fmtTime(this.player.duration)}`;
  }

  setStatus(message) {
    const status = document.getElementById("replay-list-status");
    if (status) status.textContent = message;
    const actionStatus = document.getElementById("replay-action-status");
    if (actionStatus) actionStatus.textContent = message;
  }

  exportPng() {
    if (!this.canvas || !this.player) return;
    this.canvas.toBlob(blob => {
      if (!blob) {
        this.toast("浏览器无法生成 PNG 截图");
        return;
      }
      downloadBlob(blob, `${safeFilename(document.getElementById("replay-name").textContent)}.png`);
      this.setStatus("PNG 截图已导出。");
    }, "image/png");
  }

  async exportVideo() {
    if (!this.player || !this.canvas.captureStream || !window.MediaRecorder) {
      this.toast("当前浏览器不支持 Canvas 录像导出");
      return;
    }
    if (this.mediaRecorder?.state === "recording") {
      this.cancelVideoExport = false;
      this.mediaRecorder.stop();
      return;
    }
    const mimeType = ["video/webm;codecs=vp9", "video/webm;codecs=vp8", "video/webm"]
      .find(type => MediaRecorder.isTypeSupported?.(type));
    if (!mimeType) {
      this.toast("当前浏览器没有可用的 WebM 编码器");
      return;
    }
    this.player.seek(0);
    this.player.setSpeed(1);
    this.player.play();
    this.videoChunks = [];
    this.cancelVideoExport = false;
    this.mediaRecorder = new MediaRecorder(this.canvas.captureStream(30), {
      mimeType, videoBitsPerSecond: 3_000_000,
    });
    this.mediaRecorder.addEventListener("dataavailable", event => {
      if (event.data.size) this.videoChunks.push(event.data);
    });
    this.mediaRecorder.addEventListener("stop", () => {
      if (!this.cancelVideoExport && this.videoChunks.length) {
        downloadBlob(new Blob(this.videoChunks, { type: "video/webm" }),
          `${safeFilename(document.getElementById("replay-name").textContent)}.webm`);
        this.setStatus("WebM 已按 1× 实时导出。");
      }
      this.mediaRecorder = null;
      this.cancelVideoExport = false;
      const button = document.getElementById("replay-video");
      if (button) button.textContent = "导出 WebM";
      this.renderControls();
    }, { once: true });
    this.mediaRecorder.start(500);
    document.getElementById("replay-video").textContent = "停止导出";
    this.lastFrame = performance.now();
    this.startLoop();
    this.renderControls();
  }

  async deleteSelected() {
    if (!this.player || !this.selectedId) return;
    const title = document.getElementById("replay-name").textContent;
    if (!window.confirm(`删除“${title}”？此操作无法撤销。`)) return;
    this.player.pause();
    await this.storage.delete(this.selectedId);
    this.selectedId = "";
    this.player = null;
    this.toast("录像已删除");
    await this.load();
  }
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, character => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]);
}
