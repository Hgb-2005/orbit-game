import test from "node:test";
import assert from "node:assert/strict";
import {
  BACKGROUND_OPTIONS,
  MAX_CUSTOM_SKIN_FILE_BYTES,
  RENDERER_OPTIONS,
  SKIN_OPTIONS,
  SKIN_STYLES,
  STORAGE_KEY,
  VisualSettings,
  normalizeVisualSettings,
} from "../static/js/visual/visual-settings.js";
import { ParticlePool, PARTICLE_KIND } from "../static/js/visual/particle-pool.js";
import { VisualAudioAnalyser } from "../static/js/visual/audio-visualizer.js";
import { CanvasBackground } from "../static/js/visual/canvas-background.js";
import { FluidRenderer, hexToRgb } from "../static/js/visual/fluid-renderer.js";

function memoryStorage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, String(value)); },
  };
}

function fakeCanvas(context = null) {
  return {
    width: 1,
    height: 1,
    getContext(kind) {
      if (kind === "webgl") return typeof context === "function" ? context() : context;
      return null;
    },
  };
}

function fakeWebGL() {
  const calls = { deletedBuffers: 0, deletedPrograms: 0, deletedTextures: 0, lostContexts: 0, draws: 0 };
  const gl = {
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713,
    LINK_STATUS: 35714,
    FLOAT: 5126,
    COLOR_BUFFER_BIT: 16384,
    BLEND: 3042,
    SRC_ALPHA: 770,
    ONE_MINUS_SRC_ALPHA: 771,
    TRIANGLES: 4,
    TEXTURE_2D: 3553,
    TEXTURE0: 33984,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    UNPACK_FLIP_Y_WEBGL: 37440,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    CLAMP_TO_EDGE: 33071,
    TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240,
    LINEAR: 9729,
    createShader(type) { return { type }; },
    shaderSource() {},
    compileShader() {},
    getShaderParameter() { return true; },
    getShaderInfoLog() { return ""; },
    deleteShader() {},
    createProgram() { return {}; },
    attachShader() {},
    linkProgram() {},
    getProgramParameter() { return true; },
    getProgramInfoLog() { return ""; },
    deleteProgram() { calls.deletedPrograms++; },
    createBuffer() { return {}; },
    bindBuffer() {},
    bufferData() {},
    deleteBuffer() { calls.deletedBuffers++; },
    getUniformLocation(program, name) { return { name }; },
    getAttribLocation() { return 0; },
    viewport() {},
    clearColor() {},
    clear() {},
    useProgram() {},
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    enable() {},
    disable() {},
    blendFunc() {},
    uniform1f() {},
    uniform1i() {},
    uniform2f() {},
    uniform3f() {},
    drawArrays() { calls.draws++; },
    activeTexture() {},
    bindTexture() {},
    createTexture() { return {}; },
    deleteTexture() { calls.deletedTextures++; },
    texParameteri() {},
    pixelStorei() {},
    texImage2D() {},
    getExtension(name) {
      return name === "WEBGL_lose_context" ? { loseContext() { calls.lostContexts++; } } : null;
    },
  };
  return { gl, calls };
}

function fakeContext2D() {
  const gradient = { addColorStop() {} };
  const state = { fills: 0, strokes: 0, fillRects: 0 };
  const ctx = {
    createLinearGradient() { return gradient; },
    createRadialGradient() { return gradient; },
    save() {},
    restore() {},
    translate() {},
    rotate() {},
    scale() {},
    fillRect() { state.fillRects++; },
    strokeRect() {},
    fill() { state.fills++; },
    stroke() { state.strokes++; },
    beginPath() {},
    closePath() {},
    moveTo() {},
    lineTo() {},
    arc() {},
    ellipse() {},
    set globalAlpha(value) { this._globalAlpha = value; },
    get globalAlpha() { return this._globalAlpha ?? 1; },
  };
  return { ctx, state };
}

test("视觉默认值稳定，非法枚举和数值会被归一化到安全范围", () => {
  const defaults = normalizeVisualSettings();
  assert.equal(defaults.renderer, "auto");
  assert.equal(defaults.background, "stars");
  assert.equal(defaults.skin, "solid");
  assert.equal(defaults.fluid, true);
  assert.equal(defaults.particles, 72);
  const normalized = normalizeVisualSettings({
    renderer: "metal", background: "unknown", skin: "lava",
    particles: -50, trails: 500, distortion: Number.NaN,
    customSkin: "data:image/svg+xml;base64,PHN2Zz4=",
  });
  assert.equal(normalized.renderer, "auto");
  assert.equal(normalized.background, "stars");
  assert.equal(normalized.skin, "solid");
  assert.equal(normalized.particles, 0);
  assert.equal(normalized.trails, 100);
  assert.equal(normalized.distortion, 48);
  assert.equal(normalized.customSkin, "");
});

test("公开的背景、皮肤和渲染器选项与着色器样式完整对应", () => {
  assert.deepEqual(BACKGROUND_OPTIONS.map(option => option.id),
    ["dark", "stars", "ring", "galaxy", "mountain", "blackhole"]);
  assert.deepEqual(SKIN_OPTIONS.map(option => option.id),
    ["solid", "aurora", "nebula", "ocean", "custom"]);
  assert.deepEqual(RENDERER_OPTIONS.map(option => option.id), ["auto", "webgl", "canvas"]);
  assert.deepEqual(Object.keys(SKIN_STYLES).sort(), ["aurora", "nebula", "ocean", "solid"]);
});

test("本地保存、配置导出和导入可以往返，损坏 JSON 不会覆盖当前设置", () => {
  const storage = memoryStorage();
  const settings = new VisualSettings(storage);
  let notifications = 0;
  settings.subscribe(() => notifications++);
  settings.update({ background: "blackhole", skin: "ocean", particles: 91, glow: false });
  assert.equal(notifications, 1);
  assert.ok(storage.getItem(STORAGE_KEY));
  const restored = new VisualSettings(storage);
  assert.equal(restored.snapshot.background, "blackhole");
  assert.equal(restored.snapshot.skin, "ocean");
  assert.equal(restored.snapshot.particles, 91);
  assert.equal(restored.snapshot.glow, false);

  const exported = restored.exportJSON();
  const target = new VisualSettings(memoryStorage());
  target.importJSON(exported);
  assert.deepEqual(target.snapshot, restored.snapshot);
  const before = target.snapshot;
  assert.throws(() => target.importJSON("{broken"), SyntaxError);
  assert.deepEqual(target.snapshot, before);
});

test("自定义贴图只接受受支持格式和大小，示范文件上限保持 2 MiB", () => {
  const image = "data:image/png;base64,iVBORw0KGgo=";
  assert.equal(normalizeVisualSettings({ customSkin: image }).customSkin, image);
  assert.equal(normalizeVisualSettings({ customSkin: `data:image/webp;base64,${"a".repeat(3_000_000)}` }).customSkin, "");
  assert.equal(normalizeVisualSettings({ customSkin: "https://example.com/a.png" }).customSkin, "");
  assert.equal(MAX_CUSTOM_SKIN_FILE_BYTES, 2 * 1024 * 1024);
});

test("低、中、高画质档位拥有递增且有上限的粒子和流体预算", () => {
  const settings = new VisualSettings(memoryStorage());
  settings.update({ particles: 100, trails: 100 });
  const smooth = settings.effective("smooth");
  const balanced = settings.effective("balanced");
  const detailed = settings.effective("detailed");
  assert.equal(smooth.fluid, false);
  assert.equal(smooth.particles, 24);
  assert.equal(smooth.trails, 22);
  assert.equal(smooth.maxFluidBalls, 24);
  assert.ok(balanced.particles > smooth.particles && balanced.particles <= 110);
  assert.ok(detailed.particles > balanced.particles && detailed.particles <= 220);
  assert.ok(detailed.trails > balanced.trails && detailed.trails <= 180);
});

test("固定容量粒子池复用槽位、遵守容量并可在暂停时冻结", () => {
  const pool = new ParticlePool(3);
  const first = pool.emit(10, 20, { life: 1 });
  pool.emit(20, 30);
  pool.emit(30, 40);
  const replacement = pool.emit(40, 50, { angle: 0, speed: 10, life: 1 });
  assert.equal(first, replacement);
  assert.equal(pool.items.length, 3);
  assert.equal(pool.activeCount, 3);
  const x = replacement.x;
  pool.update(.2, false, 3);
  assert.equal(replacement.x, x);
  pool.update(.2, true, 3);
  assert.ok(replacement.x > x);
  pool.clear();
  assert.equal(pool.activeCount, 0);
  assert.ok(pool.items.every(item => !item.active));
});

test("粒子更新会执行质量上限和生命周期回收，绘制清空透明度", () => {
  const pool = new ParticlePool(8);
  pool.burst(0, 0, "#fff", 8, PARTICLE_KIND.SWIRL);
  pool.update(.05, true, 4);
  assert.equal(pool.activeCount, 4);
  pool.update(2, true, 8);
  assert.equal(pool.activeCount, 0);
  pool.burst(0, 0, "#fff", 3, PARTICLE_KIND.SPARK);
  const { ctx, state } = fakeContext2D();
  assert.equal(pool.draw(ctx, 2), true);
  assert.ok(state.fills + state.fillRects > 0);
  assert.equal(ctx.globalAlpha, 1);
});

test("没有 AudioContext 或麦克风接口时返回可读错误，不创建残留资源", async () => {
  const analyser = new VisualAudioAnalyser();
  assert.equal(analyser.connectMusic(null), false);
  await assert.rejects(() => analyser.setMicrophone(true, null), /不支持麦克风频谱/);
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: {} });
  try {
    await assert.rejects(
      () => analyser.setMicrophone(true, { createMediaStreamSource() {} }),
      /不支持麦克风频谱/,
    );
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
});

test("麦克风创建失败会立即停止轨道，成功断开时也会释放采集", async () => {
  const analyser = new VisualAudioAnalyser();
  const stopped = [];
  const stream = { getTracks: () => [{ stop: () => stopped.push("track") }] };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { mediaDevices: { getUserMedia: async () => stream } },
  });
  try {
    const failingContext = { createMediaStreamSource() { throw new Error("node failed"); } };
    await assert.rejects(() => analyser.setMicrophone(true, failingContext), /node failed/);
    assert.equal(stopped.length, 1);
    assert.equal(analyser.microphoneEnabled, false);

    let disconnected = false;
    const successContext = {
      createMediaStreamSource() {
        return { connect() {}, disconnect() { disconnected = true; } };
      },
      createAnalyser() {
        return {
          fftSize: 0,
          smoothingTimeConstant: 0,
          frequencyBinCount: 4,
          getByteFrequencyData(values) { values.fill(100); },
        };
      },
    };
    assert.equal(await analyser.setMicrophone(true, successContext), true);
    assert.equal(analyser.microphoneEnabled, true);
    analyser.disconnectMicrophone();
    assert.equal(analyser.microphoneEnabled, false);
    assert.equal(disconnected, true);
    assert.equal(stopped.length, 2);
  } finally {
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
  }
});

test("音乐旁路分析器复用连接、拒绝关闭上下文并平滑输出频谱", () => {
  let connected = 0;
  let disconnected = 0;
  const analyser = {
    fftSize: 0,
    smoothingTimeConstant: 0,
    frequencyBinCount: 80,
    getByteFrequencyData(values) { values.fill(130); },
  };
  const source = { connect() { connected++; }, disconnect() { disconnected++; } };
  const music = {
    mix: source,
    context: { state: "running", createAnalyser: () => analyser },
  };
  const visual = new VisualAudioAnalyser();
  assert.equal(visual.connectMusic(music), true);
  assert.equal(visual.connectMusic(music), true);
  assert.equal(connected, 1);
  const sampled = visual.sample();
  assert.ok(sampled.level > 0 && sampled.level < 1);
  assert.ok(sampled.bass > sampled.level);
  visual.disconnectMusic();
  assert.equal(disconnected, 1);
  music.context.state = "closed";
  assert.equal(visual.connectMusic(music), false);
});

test("Canvas 兜底背景覆盖全部六种模式，尺寸变化后仍可绘制", () => {
  const background = new CanvasBackground();
  background.resize(1280, 720);
  assert.ok(background.stars.length >= 42);
  const { ctx, state } = fakeContext2D();
  for (const { id } of BACKGROUND_OPTIONS) {
    background.draw(ctx, {
      width: 1280,
      height: 720,
      mode: id,
      theme: id === "mountain" ? "light" : "dark",
      time: 4,
      camera: { x: 800, y: 400 },
      audio: .2,
      reducedMotion: false,
    });
  }
  assert.ok(state.fillRects >= 6);
  assert.ok(state.fills + state.strokes > 0);
});

test("WebGL 缺失或模式为 Canvas 时明确回退，不会伪装成流体层", () => {
  const unavailable = new FluidRenderer(fakeCanvas());
  assert.equal(unavailable.supported, false);
  assert.equal(unavailable.setRendererMode("auto"), false);
  assert.match(unavailable.reason, /未提供 WebGL/);

  const { gl } = fakeWebGL();
  const renderer = new FluidRenderer(fakeCanvas(gl));
  assert.equal(renderer.supported, true);
  assert.equal(renderer.setRendererMode("canvas"), false);
  assert.match(renderer.reason, /Canvas/);
  assert.equal(renderer.setRendererMode("auto"), true);
  assert.equal(renderer.active, true);
});

test("WebGL 图层只绘制可见预算内球体，DPR 限制为 2 并返回已绘制 ID", () => {
  const { gl, calls } = fakeWebGL();
  const canvas = fakeCanvas(gl);
  const renderer = new FluidRenderer(canvas);
  renderer.setRendererMode("webgl");
  renderer.resize(640, 360, 4);
  assert.equal(canvas.width, 1280);
  assert.equal(canvas.height, 720);
  const camera = { zoom: 1, worldToScreen: ball => ({ x: ball.x, y: ball.y }) };
  const settings = {
    background: "galaxy",
    skin: "aurora",
    customSkin: "",
    maxFluidBalls: 1,
    distortion: .5,
    glow: true,
  };
  const result = renderer.render({
    bots: [{ id: "bot", alive: true, radius: 12, mass: 50, color: "#ff0000", x: 20, y: 20 }],
    playerCells: [{ id: "hero", alive: true, radius: 20, mass: 100, color: "#00ff00", x: 80, y: 80, isPlayer: true }],
  }, { camera, theme: "dark", dpr: 1, width: 640, height: 360, settings, audio: .2 });
  assert.equal(result.drawn, 1);
  assert.equal(result.skipped, 1);
  assert.deepEqual([...result.drawnIds], ["hero"]);
  assert.equal(calls.draws, 2);
  renderer.dispose();
  assert.equal(calls.deletedBuffers, 1);
  assert.equal(calls.deletedPrograms, 1);
  assert.equal(calls.lostContexts, 1);
});

test("颜色解析支持长短十六进制并对非法颜色使用安全回退", () => {
  assert.deepEqual(hexToRgb("#f00"), [1, 0, 0]);
  assert.deepEqual(hexToRgb("#336699"), [0.2, 0.4, 0.6]);
  assert.deepEqual(hexToRgb("red", [0.1, 0.2, 0.3]), [0.1, 0.2, 0.3]);
});
