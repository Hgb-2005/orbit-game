import {
  BACKGROUND_OPTIONS,
  MAX_CUSTOM_SKIN_FILE_BYTES,
  RENDERER_OPTIONS,
  SKIN_OPTIONS,
} from "./visual-settings.js";

const $ = id => document.getElementById(id);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

function fillSelect(element, options) {
  if (!element) return;
  element.replaceChildren(...options.map(option => {
    const node = document.createElement("option");
    node.value = option.id;
    node.textContent = option.label;
    return node;
  }));
}

function readImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("图片读取失败"));
    reader.readAsDataURL(file);
  });
}

/**
 * 视觉设置面板只修改表现层参数。导入、贴图和音画联动均通过现有服务层即时生效。
 */
export class VisualSettingsUI {
  constructor(settings, {
    onOpen = () => {},
    onClose = () => {},
    onMicrophone = async () => false,
    onStatus = () => {},
  } = {}) {
    this.settings = settings;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onMicrophone = onMicrophone;
    this.onStatus = onStatus;
    this.dialog = $("visual-settings-dialog");
    this.runtime = null;
    fillSelect($("visual-renderer"), RENDERER_OPTIONS);
    fillSelect($("visual-background"), BACKGROUND_OPTIONS);
    fillSelect($("visual-skin"), SKIN_OPTIONS);
    this.bind();
    this.unsubscribe = settings.subscribe(snapshot => this.render(snapshot));
    this.render(settings.snapshot);
  }

  bind() {
    $("visual-open").addEventListener("click", () => this.open());
    $("visual-close").addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("close", () => {
      // 麦克风属于临时采集能力：关闭设置框即释放轨道，避免后台继续监听。
      if (this.settings.values.microphone) {
        this.settings.update({ microphone: false });
        void Promise.resolve(this.onMicrophone(false)).catch(() => {});
      }
      this.onClose();
      $("visual-open").focus({ preventScroll: true });
    });
    $("visual-renderer").addEventListener("change", event => {
      this.settings.update({ renderer: event.target.value });
    });
    $("visual-fluid").addEventListener("change", event => {
      this.settings.update({ fluid: event.target.checked });
    });
    $("visual-background").addEventListener("change", event => {
      this.settings.update({ background: event.target.value });
    });
    $("visual-skin").addEventListener("change", event => {
      if (event.target.value === "custom" && !this.settings.values.customSkin) {
        this.setStatus("请先上传 PNG、JPEG 或 WebP 贴图；上传前会继续使用纯色材质。", "warning");
      }
      this.settings.update({ skin: event.target.value });
    });
    for (const [id, key] of [["visual-particles", "particles"], ["visual-trails", "trails"],
      ["visual-distortion", "distortion"]]) {
      $(id).addEventListener("input", event => {
        this.settings.update({ [key]: Number(event.target.value) });
      });
    }
    $("visual-glow").addEventListener("change", event => {
      this.settings.update({ glow: event.target.checked });
    });
    $("visual-audio-reactive").addEventListener("change", event => {
      this.settings.update({ audioReactive: event.target.checked });
      this.setStatus(event.target.checked ? "音画联动已开启；开始音乐后光晕与流体速度会随频谱变化。" : "音画联动已关闭。", "ok");
    });
    $("visual-microphone").addEventListener("change", event => this.toggleMicrophone(event.target));
    $("visual-skin-file").addEventListener("change", event => void this.importSkin(event.target));
    $("visual-export").addEventListener("click", () => this.exportSettings());
    $("visual-import").addEventListener("click", () => this.importSettings());
    $("visual-reset").addEventListener("click", () => {
      this.settings.importJSON({ settings: {} });
      $("visual-json").value = this.settings.exportJSON();
      this.setStatus("视觉设置已恢复默认值；游戏规则与画质档位未改变。", "ok");
    });
  }

  open() {
    if (this.dialog.open) return;
    this.onOpen();
    this.render(this.settings.snapshot);
    $("visual-json").value = this.settings.exportJSON();
    this.dialog.showModal();
  }

  render(snapshot = this.settings.snapshot) {
    if (!this.dialog) return;
    $("visual-renderer").value = snapshot.renderer;
    $("visual-fluid").checked = snapshot.fluid;
    $("visual-background").value = snapshot.background;
    $("visual-skin").value = snapshot.skin;
    this.setRange("visual-particles", "visual-particles-value", snapshot.particles);
    this.setRange("visual-trails", "visual-trails-value", snapshot.trails);
    this.setRange("visual-distortion", "visual-distortion-value", snapshot.distortion);
    $("visual-glow").checked = snapshot.glow;
    $("visual-audio-reactive").checked = snapshot.audioReactive;
    $("visual-microphone").checked = snapshot.microphone;
    $("visual-skin-file-note").textContent = snapshot.customSkin ?
      "自定义贴图已保存到本机浏览器" : "PNG / JPEG / WebP，原图不超过 2 MiB";
    this.renderRuntime();
  }

  setRange(inputId, outputId, value) {
    const input = $(inputId);
    if (document.activeElement !== input) input.value = String(value);
    $(outputId).textContent = `${Math.round(value)}%`;
  }

  setRuntimeStatus(runtime) {
    this.runtime = runtime;
    this.renderRuntime();
  }

  renderRuntime() {
    if (!this.runtime || !$("visual-runtime-status")) return;
    const runtime = this.runtime;
    const mode = runtime.active ? "WebGL 流体层运行中" :
      runtime.renderer === "canvas" ? "Canvas 兼容模式" : "已回退 Canvas";
    const budgets = `粒子 ${runtime.effective.particles} · 拖尾 ${runtime.effective.trails} · DPR ${runtime.dpr.toFixed(2)}`;
    $("visual-runtime-status").textContent = `${mode} · ${runtime.reason} · ${budgets}`;
    $("visual-runtime-status").dataset.active = String(runtime.active);
  }

  async toggleMicrophone(input) {
    input.disabled = true;
    try {
      const enabled = await this.onMicrophone(input.checked);
      this.settings.update({ microphone: Boolean(enabled) });
      input.checked = Boolean(enabled);
      this.setStatus(enabled ? "麦克风频谱已开启；只在本次页面会话中采集，关闭后立即释放。" :
        "麦克风频谱已关闭。", "ok");
    } catch (error) {
      input.checked = false;
      this.settings.update({ microphone: false });
      const reason = error instanceof Error ? error.message : String(error);
      this.setStatus(`无法开启麦克风：${reason}。请检查浏览器权限或改用背景音乐联动。`, "error");
    } finally {
      input.disabled = false;
    }
  }

  async importSkin(input) {
    const file = input.files?.[0];
    input.value = "";
    if (!file) return;
    if (!IMAGE_TYPES.has(file.type)) {
      this.setStatus("贴图格式无效，请选择 PNG、JPEG 或 WebP。", "error");
      return;
    }
    if (file.size > MAX_CUSTOM_SKIN_FILE_BYTES) {
      this.setStatus("贴图超过 2 MiB，请压缩后重试。", "error");
      return;
    }
    try {
      const dataUrl = await readImage(file);
      if (!dataUrl || dataUrl.length > 2_800_000) throw new Error("贴图编码后体积过大");
      this.settings.update({ customSkin: dataUrl, skin: "custom" });
      this.setStatus(`贴图「${file.name}」已应用；仅你的主球使用自定义材质。`, "ok");
    } catch (error) {
      this.setStatus(`贴图导入失败：${error instanceof Error ? error.message : String(error)}`, "error");
    }
  }

  exportSettings() {
    const json = this.settings.exportJSON();
    $("visual-json").value = json;
    const blob = new Blob([json], { type: "application/json" });
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = "orbit-visual-settings.json";
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 0);
    this.setStatus("视觉配置已导出。", "ok");
  }

  importSettings() {
    try {
      this.settings.importJSON($("visual-json").value);
      $("visual-json").value = this.settings.exportJSON();
      this.setStatus("视觉配置已导入并即时生效。", "ok");
    } catch (error) {
      this.setStatus(`导入失败：${error instanceof Error ? error.message : "JSON 格式无效"}`, "error");
    }
  }

  setStatus(message, kind = "") {
    const status = $("visual-settings-status");
    status.textContent = message;
    status.dataset.kind = kind;
    this.onStatus(message);
  }

  dispose() {
    this.unsubscribe?.();
  }
}
