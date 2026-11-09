import { SKIN_STYLES } from "./visual-settings.js";

const VERTEX_SHADER = `#version 100
attribute vec2 a_position;
uniform vec2 u_resolution;
uniform vec2 u_center;
uniform float u_radius;
uniform float u_fullscreen;
uniform float u_glow;
varying vec2 v_uv;
varying vec2 v_screen;

void main() {
  if (u_fullscreen > 0.5) {
    v_uv = a_position * 0.5 + 0.5;
    v_screen = v_uv;
    gl_Position = vec4(a_position, 0.0, 1.0);
  } else {
    vec2 clip_center = vec2(u_center.x / u_resolution.x * 2.0 - 1.0,
                            1.0 - u_center.y / u_resolution.y * 2.0);
    vec2 size = vec2(u_radius * (1.0 + u_glow * 0.42) / u_resolution.x * 2.0,
                     u_radius * (1.0 + u_glow * 0.42) / u_resolution.y * 2.0);
    v_uv = a_position;
    v_screen = (clip_center + a_position * size) * 0.5 + 0.5;
    gl_Position = vec4(clip_center + a_position * size, 0.0, 1.0);
  }
}`;

const FRAGMENT_SHADER = `#version 100
precision highp float;
varying vec2 v_uv;
varying vec2 v_screen;

uniform float u_kind;
uniform float u_time;
uniform float u_theme;
uniform float u_background;
uniform float u_audio;
uniform vec3 u_color;
uniform vec3 u_accent;
uniform float u_seed;
uniform float u_flow;
uniform float u_distortion;
uniform float u_lod;
uniform float u_glow;
uniform sampler2D u_texture;
uniform float u_has_texture;

vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                     -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy), dot(x12.zw, x12.zw)), 0.0);
  m = m * m; m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

float fbm(vec2 p) {
  float value = 0.0;
  float amplitude = 0.54;
  for (int i = 0; i < 4; i++) {
    value += snoise(p) * amplitude;
    p = p * 2.03 + vec2(17.1, 9.2);
    amplitude *= 0.5;
  }
  return value;
}

float hash21(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

vec3 background_color(vec2 uv) {
  vec3 dark_base = vec3(0.038, 0.075, 0.064);
  vec3 light_base = vec3(0.84, 0.90, 0.84);
  vec3 base = mix(dark_base, light_base, u_theme);
  vec3 glow = mix(vec3(0.38, 0.76, 0.53), vec3(0.30, 0.59, 0.38), u_theme);
  vec3 accent = mix(vec3(0.78, 0.61, 0.28), vec3(0.64, 0.45, 0.15), u_theme);
  float mode = u_background;
  if (u_background < 0.5) return base;

  if (u_background < 1.5) {
    vec2 grid = floor(uv * vec2(170.0, 105.0));
    vec2 cell = fract(uv * vec2(170.0, 105.0));
    float h = hash21(grid);
    float star = smoothstep(0.045, 0.0, distance(cell, vec2(0.5))) * step(0.86, h);
    float drift = 0.65 + 0.35 * sin(u_time * 0.45 + h * 18.0);
    return base + mix(glow, accent, h) * star * drift * mix(0.34, 0.2, u_theme);
  }
  if (u_background < 2.5) {
    vec2 p = uv - vec2(0.62, 0.48);
    float radius = length(p * vec2(1.0, 1.8));
    float ring = pow(0.5 + 0.5 * sin(radius * 52.0 - u_time * 0.32), 5.0);
    float halo = exp(-radius * 3.6);
    return base + glow * halo * (0.13 + u_audio * 0.06) + accent * ring * halo * 0.18;
  }
  if (u_background < 3.5) {
    vec2 p = (uv - 0.5) * vec2(2.0, 3.3);
    float angle = atan(p.y, p.x);
    float radius = length(p);
    float spiral = fbm(p * 2.1 + vec2(cos(angle + radius * 4.0 + u_time * 0.025), sin(angle)) * 0.85);
    float cloud = smoothstep(-0.5, 0.75, spiral) * exp(-radius * 1.35);
    float dust = smoothstep(0.55, 0.85, hash21(floor(uv * 210.0))) * exp(-radius * 1.3);
    return base + glow * cloud * 0.19 + accent * dust * 0.12;
  }
  if (u_background < 4.5) {
    float sun = smoothstep(0.08, 0.0, distance(uv, vec2(0.76, 0.22)));
    float horizon = smoothstep(0.58, 0.90, uv.y);
    float ridge = sin(uv.x * 13.0 + u_time * 0.012) * 0.035 + sin(uv.x * 31.0) * 0.018;
    float mountain = smoothstep(0.50 + ridge, 0.53 + ridge, uv.y);
    return mix(base, glow * 0.6 + base * 0.4, horizon * 0.38) + accent * sun * 0.12 + glow * mountain * 0.11;
  }
  vec2 p = uv - vec2(0.54, 0.48);
  float radius = length(p);
  float warp = sin(atan(p.y, p.x) * 5.0 + radius * 21.0 - u_time * 0.18);
  float rings = smoothstep(0.12, 0.0, abs(radius - 0.28 - warp * 0.008));
  float disk = exp(-abs(p.y) * 22.0) * smoothstep(0.62, 0.18, radius);
  float hole = smoothstep(0.15, 0.16, radius);
  vec3 color = base + glow * rings * disk * (0.34 + u_audio * 0.18) + accent * rings * 0.09;
  return mix(color, vec3(0.01, 0.018, 0.015), hole);
}

void main() {
  if (u_kind < 0.5) {
    gl_FragColor = vec4(background_color(v_uv), 1.0);
    return;
  }

  float radius = length(v_uv);
  // WebGL1 不保证 OES_standard_derivatives；固定抗锯齿宽度可在所有目标设备工作。
  float aa = 0.003;
  float inside = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, radius);
  float outer = 1.0 - smoothstep(1.0, 1.38, radius);
  float edge = smoothstep(0.78, 0.98, radius) * outer;
  vec3 base = u_color;
  float n = 0.0;
  if (u_lod > 0.5) {
    n = fbm(v_uv * u_flow + vec2(u_seed * 7.1, u_seed * 3.7 + u_time * 0.18));
  } else {
    n = snoise(v_uv * 2.1 + vec2(u_seed, u_time * 0.06));
  }
  float fluid = smoothstep(-0.65, 0.85, n) * u_distortion;
  vec3 flow_color = mix(base, u_accent, fluid * 0.62);
  flow_color *= 0.88 + (1.0 - radius) * 0.23;
  flow_color += vec3(0.08) * pow(max(0.0, n), 2.0);
  if (u_has_texture > 0.5) {
    vec2 texture_uv = vec2(v_uv.x * 0.5 + 0.5, 0.5 - v_uv.y * 0.5);
    vec4 texture_color = texture2D(u_texture, texture_uv);
    flow_color = mix(flow_color, texture_color.rgb, texture_color.a * 0.82);
  }
  vec3 halo = u_accent * edge * (0.18 + u_glow * 0.32) + base * edge * 0.14;
  vec3 final_color = mix(flow_color, halo, 1.0 - inside);
  float alpha = max(inside, edge * u_glow * 0.65);
  alpha *= mix(0.9, 1.0, inside);
  gl_FragColor = vec4(final_color, alpha);
}`;

function hexToRgb(color, fallback = [0.5, 0.8, 0.6]) {
  const value = typeof color === "string" ? color.trim() : "";
  const match = /^#([0-9a-f]{6})$/i.exec(value) || /^#([0-9a-f]{3})$/i.exec(value);
  if (!match) return fallback;
  let hex = match[1];
  if (hex.length === 3) hex = [...hex].map(part => part + part).join("");
  return [parseInt(hex.slice(0, 2), 16) / 255, parseInt(hex.slice(2, 4), 16) / 255, parseInt(hex.slice(4, 6), 16) / 255];
}

function seededColor(id) {
  let seed = 2166136261;
  for (const character of String(id)) seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  return seed / 4294967296;
}

function compile(gl, type, source) {
  const shader = gl.createShader(type);
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    const message = gl.getShaderInfoLog(shader) || "WebGL shader compilation failed";
    gl.deleteShader(shader);
    throw new Error(message);
  }
  return shader;
}

function createProgram(gl) {
  const program = gl.createProgram();
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    const message = gl.getProgramInfoLog(program) || "WebGL program link failed";
    gl.deleteProgram(program);
    throw new Error(message);
  }
  return program;
}

/**
 * 独立透明 WebGL 绘制层。主 Canvas 2D 始终负责规则无关的 HUD、标签和兜底绘制；
 * 此模块只输出背景与球体材质，不接触实体、网络快照或碰撞数据。
 */
export class FluidRenderer {
  constructor(canvas, { forced = "auto" } = {}) {
    this.canvas = canvas;
    this.forced = forced;
    this.supported = false;
    this.active = false;
    this.reason = "未初始化";
    this.width = 1;
    this.height = 1;
    this.dpr = 1;
    this.startTime = performance.now();
    this.texture = null;
    this.textureReady = false;
    this.skinSource = "";
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.locations = {};
    if (!canvas) { this.reason = "页面缺少 WebGL 图层"; return; }
    try {
      this.gl = canvas.getContext("webgl", {
        alpha: true, antialias: false, depth: false, stencil: false,
        premultipliedAlpha: false, powerPreference: "high-performance",
      });
      if (!this.gl) throw new Error("浏览器未提供 WebGL 上下文");
      this.program = createProgram(this.gl);
      this.buffer = this.gl.createBuffer();
      this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.buffer);
      this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array([
        -1, -1, 1, -1, -1, 1,
        -1, 1, 1, -1, 1, 1,
      ]), this.gl.STATIC_DRAW);
      this.cacheLocations();
      this.supported = true;
      this.reason = "WebGL 可用";
    } catch (error) {
      this.supported = false;
      this.reason = error instanceof Error ? error.message : String(error);
      try { this.gl?.getExtension("WEBGL_lose_context")?.loseContext(); } catch { /* 已失败的上文无需额外处理。 */ }
      this.gl = null;
    }
  }

  cacheLocations() {
    const gl = this.gl;
    const names = ["a_position", "u_resolution", "u_center", "u_radius", "u_fullscreen", "u_glow",
      "u_kind", "u_time", "u_theme", "u_background", "u_audio", "u_color", "u_accent", "u_seed",
      "u_flow", "u_distortion", "u_lod", "u_texture", "u_has_texture"];
    for (const name of names) {
      const location = gl.getUniformLocation(this.program, name);
      if (location !== null) this.locations[name] = location;
    }
    this.attributes = { position: gl.getAttribLocation(this.program, "a_position") };
  }

  setRendererMode(mode) {
    this.forced = mode;
    if (mode === "canvas") {
      this.active = false;
      this.reason = "已选择 Canvas 兼容模式";
    } else if (!this.supported) {
      this.active = false;
    } else {
      this.active = true;
      this.reason = mode === "webgl" ? "WebGL 流体已启用" : "自动 · WebGL";
    }
    return this.active;
  }

  resize(width, height, dpr = 1) {
    if (!this.gl) return;
    const nextDpr = Math.max(1, Math.min(2, dpr || 1));
    const nextWidth = Math.max(1, Math.round(width));
    const nextHeight = Math.max(1, Math.round(height));
    if (this.width === nextWidth && this.height === nextHeight && this.dpr === nextDpr &&
        this.canvas.width === Math.round(nextWidth * nextDpr) &&
        this.canvas.height === Math.round(nextHeight * nextDpr)) return;
    this.width = nextWidth;
    this.height = nextHeight;
    this.dpr = nextDpr;
    this.canvas.width = Math.round(this.width * nextDpr);
    this.canvas.height = Math.round(this.height * nextDpr);
  }

  setCustomSkin(dataUrl) {
    if (!this.gl || dataUrl === this.skinSource) return;
    this.skinSource = dataUrl || "";
    if (!dataUrl) {
      this.textureReady = false;
      return;
    }
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (!this.gl || this.skinSource !== dataUrl) return;
      if (this.texture) this.gl.deleteTexture(this.texture);
      this.texture = this.gl.createTexture();
      this.gl.bindTexture(this.gl.TEXTURE_2D, this.texture);
      this.gl.pixelStorei(this.gl.UNPACK_FLIP_Y_WEBGL, 1);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_S, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_WRAP_T, this.gl.CLAMP_TO_EDGE);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MIN_FILTER, this.gl.LINEAR);
      this.gl.texParameteri(this.gl.TEXTURE_2D, this.gl.TEXTURE_MAG_FILTER, this.gl.LINEAR);
      this.gl.texImage2D(this.gl.TEXTURE_2D, 0, this.gl.RGBA, this.gl.RGBA, this.gl.UNSIGNED_BYTE, image);
      this.textureReady = true;
    };
    image.onerror = () => { this.textureReady = false; };
    image.src = dataUrl;
  }

  render(snapshot, options) {
    if (!this.active || !this.gl || !this.supported) return { drawn: 0, skipped: 0 };
    const gl = this.gl;
    const {
      camera, theme = "dark", dpr = 1, width = this.width, height = this.height,
      settings, displayRadius = ball => ball.radius, audio = 0, reducedMotion = false,
      drawBalls = true,
    } = options;
    this.resize(width, height, dpr);
    if (!this.dpr || this.width < 1 || this.height < 1) return { drawn: 0, skipped: 0, drawnIds: new Set() };
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.attributes.position);
    gl.vertexAttribPointer(this.attributes.position, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    const time = reducedMotion ? 0 : (performance.now() - this.startTime) / 1000;
    const modeIndex = ["dark", "stars", "ring", "galaxy", "mountain", "blackhole"].indexOf(settings.background);
    this.drawBackground(Math.max(0, modeIndex), time, theme, audio);
    if (!drawBalls) {
      gl.disable(gl.BLEND);
      return { drawn: 0, skipped: 0, drawnIds: new Set() };
    }
    this.setCustomSkin(settings.customSkin);

    const balls = [...snapshot.bots, ...snapshot.playerCells].filter(ball => ball.alive)
      .sort((left, right) => right.mass - left.mass);
    let drawn = 0, skipped = 0;
    const drawnIds = new Set();
    for (const ball of balls) {
      const point = camera.worldToScreen(ball);
      const radius = displayRadius(ball) * camera.zoom;
      if (point.x + radius * 1.5 < 0 || point.x - radius * 1.5 > this.width ||
          point.y + radius * 1.5 < 0 || point.y - radius * 1.5 > this.height) continue;
      if (drawn >= settings.maxFluidBalls) { skipped++; continue; }
      const fill = snapshot.team ? ball.color : ball.isPlayer ? "#b4efcc" : ball.color;
      this.drawBall(ball, point, radius, fill, time, theme, settings, audio);
      drawnIds.add(ball.id);
      drawn++;
    }
    gl.disable(gl.BLEND);
    return { drawn, skipped, drawnIds };
  }

  drawBackground(mode, time, theme, audio) {
    const gl = this.gl, loc = this.locations;
    gl.uniform1f(loc.u_kind, 0);
    gl.uniform1f(loc.u_fullscreen, 1);
    gl.uniform1f(loc.u_time, time);
    gl.uniform1f(loc.u_theme, theme === "light" ? 1 : 0);
    gl.uniform1f(loc.u_background, mode);
    gl.uniform1f(loc.u_audio, Math.max(0, Math.min(1, audio)));
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  drawBall(ball, point, radius, color, time, theme, settings, audio) {
    const gl = this.gl, loc = this.locations;
    const skin = SKIN_STYLES[settings.skin] ?? SKIN_STYLES.solid;
    const rgb = hexToRgb(color);
    const accent = skin.accent;
    const glow = settings.glow ? 1 : 0;
    const simple = radius < 9 ? 1 : 0;
    gl.uniform1f(loc.u_kind, 1);
    gl.uniform1f(loc.u_fullscreen, 0);
    gl.uniform2f(loc.u_resolution, this.width, this.height);
    gl.uniform2f(loc.u_center, point.x, point.y);
    gl.uniform1f(loc.u_radius, radius);
    gl.uniform1f(loc.u_glow, glow);
    gl.uniform1f(loc.u_time, time);
    gl.uniform1f(loc.u_theme, theme === "light" ? 1 : 0);
    gl.uniform1f(loc.u_audio, Math.max(0, Math.min(1, audio)));
    gl.uniform3f(loc.u_color, rgb[0] * (1 - skin.saturation * .2), rgb[1], rgb[2] * (1 + skin.saturation * .12));
    gl.uniform3f(loc.u_accent, accent[0], accent[1], accent[2]);
    gl.uniform1f(loc.u_seed, seededColor(ball.id));
    gl.uniform1f(loc.u_flow, skin.flowScale);
    gl.uniform1f(loc.u_distortion, settings.distortion);
    gl.uniform1f(loc.u_lod, simple ? 0 : 1);
    const hasTexture = settings.skin === "custom" && this.textureReady && ball.isPlayer ? 1 : 0;
    gl.uniform1f(loc.u_has_texture, hasTexture);
    if (hasTexture) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.texture);
      gl.uniform1i(loc.u_texture, 0);
    }
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  dispose() {
    this.active = false;
    try {
      if (this.texture) this.gl?.deleteTexture(this.texture);
      if (this.buffer) this.gl?.deleteBuffer(this.buffer);
      if (this.program) this.gl?.deleteProgram(this.program);
      this.gl?.getExtension("WEBGL_lose_context")?.loseContext();
    } catch { /* 页面卸载时驱动可能已释放上下文。 */ }
  }
}

export { VERTEX_SHADER, FRAGMENT_SHADER, hexToRgb };
