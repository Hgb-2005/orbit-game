import { CONFIG } from "./config.js";
import { describeBallLabel, layoutBallLabels } from "./presentation/labels.js";
import { CombatFeedback, nearestDanger } from "./presentation/combat-feedback.js";
import { RenderQuality } from "./presentation/quality.js";
import { smoothDisplayRadius } from "./presentation/radius-smoothing.js";
import { splitProjection, FrameMetrics, SIGNAL_COLORS, SIGNAL_NAMES } from './presentation/tactics.js';
import { VisualSettings } from "./visual/visual-settings.js";
import { CanvasBackground } from "./visual/canvas-background.js";
import { FluidRenderer } from "./visual/fluid-renderer.js";
import { ParticlePool, PARTICLE_KIND } from "./visual/particle-pool.js";

const THEMES = {
  dark: { background: "#101a17", grid: "#26342b", border: "#586f5e", text: "#d6e0d9", muted: "#718979", player: "#b4efcc", playerInk: "#203d2a", mini: "#15211ce8", miniBorder: "#334539" },
  light: { background: "#eaf0e8", grid: "#d1ddce", border: "#90aa92", text: "#3a523d", muted: "#6f8a71", player: "#78ba8b", playerInk: "#153e22", mini: "#f4f8f0ed", miniBorder: "#b6cbb5" },
};

/** Canvas 只读取状态，所有坐标都使用世界坐标，最后由相机统一变换。 */
export class Renderer {
  constructor(canvas, camera, visualCanvas = null) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.camera = camera;
    this.visualCanvas = visualCanvas;
    this.theme = "dark";
    this.width = 1;
    this.height = 1;
    this.combat = new CombatFeedback();
    this.trailTimer = 0;
    this.labelObstacles = [];
    this.labelPlacements = [];
    this.displayRadii = new Map();
    let storage = null;
    try { storage = window.localStorage; } catch { /* 无存储权限仍可调画质。 */ }
    this.quality = new RenderQuality(storage);
    this.visualSettings = new VisualSettings(storage);
    this.visuals = this.visualSettings.effective(this.quality.effective);
    this.background = new CanvasBackground();
    this.fluidRenderer = new FluidRenderer(visualCanvas);
    this.particlePool = new ParticlePool(220);
    this.audio = { level: 0, bass: 0, mid: 0 };
    this.visualFallbackReason = "";
    this.metrics = new FrameMetrics();
    this.frameMs = 16.67;
    this.previewEnabled = false;
    this.aim = null;
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.touchQuery = window.matchMedia("(pointer: coarse), (max-width: 760px)");
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.unsubscribeVisuals = this.visualSettings.subscribe(() => this.syncVisualSettings());
    this.resize();
    this.syncVisualSettings();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.touchMode = this.touchQuery.matches;
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, this.quality.preset.dpr);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.background.resize(this.width, this.height);
    this.fluidRenderer.resize(this.width, this.height, this.dpr);
  }

  addEvents(events) {
    this.combat.add(events);
    if (this.reducedMotion || this.visuals.particles <= 0) return;
    for (const event of events) {
      if (!["food", "eat", "split", "merge", "celllost", "respawn", "spore", "spore-eat",
        "spike", "spike-feed", "spike-launch", "item", "shield-block", "combo"].includes(event.type)) continue;
      if (event.type === "respawn" && !event.isPlayer) continue;
      const room = Math.max(0, this.visuals.particles - this.particlePool.activeCount);
      if (!room) break;
      const color = event.color || (this.theme === "dark" ? "#b4efcc" : "#71b98a");
      if (event.type === "food" || event.type === "eat" || event.type === "spore-eat") {
        this.particlePool.burst(event.x, event.y, color,
          Math.min(room, event.type === "food" ? 3 : 7), PARTICLE_KIND.SWIRL);
      } else if (event.type === "spore") {
        this.particlePool.trail(event.x, event.y, color, event.radius || 7, PARTICLE_KIND.TRAIL);
      } else if (event.type === "spike" || event.type === "spike-feed" || event.type === "spike-launch") {
        this.particlePool.burst(event.x, event.y, "#8fe1aa",
          Math.min(room, event.type === "spike-launch" ? 12 : 5), PARTICLE_KIND.SPARK);
      } else if (event.type === "celllost") {
        this.particlePool.burst(event.x, event.y, "#ed9f94",
          Math.min(room, 10), PARTICLE_KIND.SWIRL);
      } else if (event.type === "item" || event.type === "shield-block") {
        this.particlePool.burst(event.x, event.y, event.color || "#82b8d8",
          Math.min(room, event.type === "shield-block" ? 9 : 7), PARTICLE_KIND.SPARK);
      } else if (event.type === "combo") {
        this.particlePool.burst(event.x, event.y, "#e0bd80",
          Math.min(room, 12), PARTICLE_KIND.SWIRL);
      } else {
        this.particlePool.burst(event.x, event.y, color,
          Math.min(room, event.type === "split" ? 8 : 5), PARTICLE_KIND.BURST);
      }
    }
  }

  resetEffects() {
    this.combat.reset();
    this.particlePool.clear();
    this.trailTimer = 0;
    this.displayRadii.clear();
  }

  setQuality(mode) {
    if (!this.quality.setMode(mode)) return;
    this.applyQuality();
  }

  applyQuality() {
    this.syncVisualSettings();
    this.combat.rings = this.combat.rings.slice(-this.quality.preset.rings);
    this.resize();
  }

  syncVisualSettings() {
    this.visuals = this.visualSettings.effective(this.quality.effective);
    this.fluidRenderer.setRendererMode(this.visualSettings.values.renderer);
    this.fluidRenderer.setCustomSkin(this.visuals.skin === "custom" ? this.visuals.customSkin : "");
    return this.getVisualStatus();
  }

  setAudioLevel(audio) {
    const value = typeof audio === "number" ? { level: audio } : audio;
    this.audio = {
      level: Math.max(0, Math.min(1, Number(value?.level) || 0)),
      bass: Math.max(0, Math.min(1, Number(value?.bass) || 0)),
      mid: Math.max(0, Math.min(1, Number(value?.mid) || 0)),
    };
  }

  getVisualStatus() {
    return {
      renderer: this.visualSettings.values.renderer,
      fluid: this.visuals.fluid,
      active: Boolean(this.fluidRenderer.active && !this.visualFallbackReason),
      supported: this.fluidRenderer.supported,
      reason: this.visualFallbackReason || this.fluidRenderer.reason,
      width: this.width,
      height: this.height,
      dpr: this.dpr,
      effective: this.visuals,
    };
  }

  draw(snapshot, dt, feedback) {
    const drawStarted = performance.now();
    this.prepareDisplayRadii(snapshot, dt);
    this.combat.update(dt, snapshot.state === "playing");
    const { ctx, camera } = this;
    const colors = THEMES[this.theme];
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    const audio = this.visuals.audioReactive ? this.audio.level : 0;
    let fluidResult = { drawn: 0, skipped: 0, drawnIds: new Set() };
    try {
      fluidResult = this.fluidRenderer.render(snapshot, {
        camera, theme: this.theme, dpr: this.dpr, width: this.width, height: this.height,
        settings: this.visuals, displayRadius: ball => this.displayRadius(ball),
        audio, reducedMotion: this.reducedMotion, drawBalls: this.visuals.fluid,
      });
    } catch (error) {
      // 驱动丢失或着色器异常时立即切回 Canvas，不影响本局推进。
      this.visualFallbackReason = error instanceof Error ? error.message : String(error);
      this.fluidRenderer.active = false;
    }
    if (!this.fluidRenderer.active) {
      this.background.draw(ctx, {
        width: this.width, height: this.height, mode: this.visuals.background,
        theme: this.theme, time: performance.now() / 1000, camera,
        audio, reducedMotion: this.reducedMotion,
      });
    }
    const drawnIds = fluidResult.drawnIds ?? new Set();
    ctx.save();
    ctx.translate(this.width / 2, this.height / 2);
    ctx.scale(camera.zoom, camera.zoom);
    ctx.translate(-camera.x, -camera.y);
    this.drawGrid(snapshot.bounds, colors);
    this.drawHotspots(snapshot, colors);
    this.drawSpikes(snapshot, colors);

    for (const spore of snapshot.spores || []) {
      if (!this.visible(spore)) continue;
      ctx.fillStyle = spore.color || "#9bd7bc";
      ctx.globalAlpha = 0.92;
      ctx.beginPath();
      ctx.arc(spore.x, spore.y, spore.radius || 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }

    for (const food of snapshot.foods) {
      if (!this.visible(food)) continue;
      ctx.fillStyle = food.color;
      ctx.globalAlpha = 0.8;
      ctx.beginPath();
      ctx.arc(food.x, food.y, food.radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    this.drawItems(snapshot);
    this.drawSafeZone(snapshot);
    if (this.previewEnabled) this.drawSplitPreview(snapshot, colors);

    if (snapshot.state === "playing" && !this.reducedMotion && this.visuals.trails > 0) {
      this.trailTimer += dt;
      const interval = this.quality.effective === "smooth" ? .16 : .09;
      if (this.trailTimer > interval) {
        this.trailTimer = 0;
        for (const cell of snapshot.playerCells) {
          if (this.particlePool.activeCount >= this.visuals.trails) break;
          if (Math.hypot(cell.vx || 0, cell.vy || 0) < 14) continue;
          this.particlePool.trail(cell.x, cell.y, colors.player,
            this.displayRadius(cell), PARTICLE_KIND.TRAIL);
        }
      }
    }

    if (snapshot.regrouping && snapshot.playerCells.length > 1) {
      ctx.save();
      ctx.strokeStyle = colors.player;
      ctx.globalAlpha = .25;
      ctx.lineWidth = 1.25 / this.camera.zoom;
      ctx.setLineDash([5 / this.camera.zoom, 7 / this.camera.zoom]);
      ctx.beginPath();
      for (const cell of snapshot.playerCells) {
        ctx.moveTo(cell.x, cell.y); ctx.lineTo(snapshot.player.x, snapshot.player.y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.beginPath(); ctx.arc(snapshot.player.x, snapshot.player.y, 10 / this.camera.zoom, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
    const balls = [...snapshot.bots, ...snapshot.playerCells].filter(ball => ball.alive).sort((a, b) => a.mass - b.mass);
    for (const ball of balls) {
      if (this.visible(ball)) this.drawBall(ball, snapshot, colors, !drawnIds.has(ball.id));
    }
    this.drawCombatRings(snapshot);
    this.drawSignals(snapshot);

    this.particlePool.update(dt, snapshot.state === "playing", this.visuals.particles);
    this.particlePool.draw(ctx, this.visuals.particles);
    ctx.globalAlpha = 1;
    ctx.restore();
    if (snapshot.state === "playing") this.drawDirection(snapshot, colors);
    this.drawBallLabels(balls.filter(ball => this.visible(ball)), snapshot, colors);
    this.drawCombatText(colors);
    this.drawMiniMap(snapshot, colors, feedback);
    const drawCost = performance.now() - drawStarted;
    const liveBalls = [...snapshot.playerCells, ...snapshot.bots].filter(ball => ball.alive);
    const aliveCount = new Set(liveBalls.map(ball => ball.ownerId)).size;
    const aiCount = new Set(snapshot.bots.filter(ball => ball.alive).map(ball => ball.ownerId)).size;
    this.metrics.observe(this.frameMs, drawCost, snapshot.state === 'playing', {
      cellCount: liveBalls.length,
      aiCount,
      aliveCount,
      simulationMs: snapshot.metrics?.simulationMs,
      collisionMs: snapshot.metrics?.collisionMs,
    });
    if (this.quality.observe(drawCost, dt, snapshot.state === "playing")) this.applyQuality();
  }

  prepareDisplayRadii(snapshot, dt) {
    const visibleIds = new Set();
    for (const ball of [...snapshot.playerCells, ...snapshot.bots]) {
      if (!ball.alive) continue;
      visibleIds.add(ball.id);
      const previous = this.displayRadii.get(ball.id);
      const radius = smoothDisplayRadius(previous, ball.radius, dt, previous === undefined);
      this.displayRadii.set(ball.id, radius);
    }
    for (const id of this.displayRadii.keys()) {
      if (!visibleIds.has(id)) this.displayRadii.delete(id);
    }
  }

  displayRadius(ball) {
    return this.displayRadii.get(ball.id) ?? ball.radius;
  }

  drawSafeZone(snapshot) {
    const zone = snapshot.safeZone;
    if (!zone) return;
    const { ctx } = this;
    ctx.save();
    ctx.beginPath(); ctx.rect(0, 0, snapshot.bounds.width, snapshot.bounds.height); ctx.clip();
    ctx.fillStyle = this.theme === 'dark' ? '#a171ce24' : '#7042a329';
    ctx.beginPath(); ctx.rect(0, 0, snapshot.bounds.width, snapshot.bounds.height);
    ctx.moveTo(zone.x + zone.radius, zone.y); ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
    ctx.fill('evenodd');
    ctx.strokeStyle = this.theme === 'dark' ? '#b99add' : '#8151aa';
    ctx.lineWidth = 2.5 / this.camera.zoom;
    ctx.beginPath(); ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2); ctx.stroke();
    if (['warning', 'shrinking'].includes(zone.phase)) {
      ctx.strokeStyle = this.theme === 'dark' ? '#e0bd80' : '#9a7329';
      ctx.setLineDash([10 / this.camera.zoom, 7 / this.camera.zoom]);
      ctx.beginPath(); ctx.arc(zone.x, zone.y, zone.nextRadius, 0, Math.PI * 2); ctx.stroke();
    }
    ctx.restore();
  }

  /** 道具只用色块、符号和脉冲绘制，关闭全部特效时仍能清楚辨认。 */
  drawItems(snapshot) {
    const items = snapshot.items?.items;
    if (!items?.length) return;
    const { ctx, camera } = this;
    const pulse = this.reducedMotion ? 0 : (Math.sin(performance.now() / 210) + 1) / 2;
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const item of items) {
      if (!this.visible(item)) continue;
      const radius = item.radius || 12;
      ctx.globalAlpha = 0.12 + pulse * 0.08;
      ctx.fillStyle = item.color;
      ctx.beginPath();
      ctx.arc(item.x, item.y, radius + 7 + pulse * 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 0.96;
      ctx.fillStyle = this.theme === "dark" ? "#142019" : "#f7f5eb";
      ctx.strokeStyle = item.color;
      ctx.lineWidth = 2 / camera.zoom;
      ctx.beginPath();
      ctx.arc(item.x, item.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.fillStyle = item.color;
      ctx.font = `700 ${Math.max(10, radius * 0.9) / camera.zoom}px 'Microsoft YaHei', sans-serif`;
      ctx.fillText(item.symbol || "", item.x, item.y + 1 / camera.zoom);
    }
    ctx.restore();
  }

  drawSplitPreview(snapshot, colors) {
    const ghosts = splitProjection(snapshot, this.aim);
    if (!ghosts.length) return;
    const { ctx } = this;
    ctx.save(); ctx.strokeStyle = this.theme === 'light' ? '#32774e' : colors.player; ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = 1.25 / this.camera.zoom; ctx.globalAlpha = .62;
    ctx.setLineDash([5 / this.camera.zoom, 5 / this.camera.zoom]);
    ctx.font = `${10 / this.camera.zoom}px sans-serif`; ctx.textAlign = 'center';
    for (const ghost of ghosts) {
      ctx.beginPath(); ctx.moveTo(ghost.from.x, ghost.from.y); ctx.lineTo(ghost.x, ghost.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(ghost.x, ghost.y, ghost.radius, 0, Math.PI * 2); ctx.stroke();
      ctx.fillText(`½ ${Math.round(ghost.mass)} m`, ghost.x, ghost.y + 4 / this.camera.zoom);
    }
    ctx.restore();
  }

  drawSignals(snapshot) {
    const { ctx } = this;
    ctx.save(); ctx.textAlign = 'center'; ctx.lineWidth = 2 / this.camera.zoom;
    ctx.font = `${11 / this.camera.zoom}px sans-serif`;
    for (const ping of snapshot.pings || []) {
      ctx.globalAlpha = Math.min(1, Math.max(0, ping.expiresAt - snapshot.elapsed));
      ctx.strokeStyle = ctx.fillStyle = SIGNAL_COLORS[ping.kind];
      const radius = 12 / this.camera.zoom;
      ctx.beginPath(); ctx.arc(ping.x, ping.y, radius, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.moveTo(ping.x - radius * .5, ping.y); ctx.lineTo(ping.x + radius * .5, ping.y);
      ctx.moveTo(ping.x, ping.y - radius * .5); ctx.lineTo(ping.x, ping.y + radius * .5); ctx.stroke();
      ctx.fillText(`${ping.name} · ${SIGNAL_NAMES[ping.kind]}`, ping.x, ping.y - 20 / this.camera.zoom);
    }
    ctx.restore();
  }

  visible(entity) {
    const point = this.camera.worldToScreen(entity);
    const radius = this.displayRadius(entity) * this.camera.zoom + 35;
    return point.x > -radius && point.x < this.width + radius && point.y > -radius && point.y < this.height + radius;
  }

  drawHotspots(snapshot, colors) {
    const { ctx, camera } = this;
    for (const zone of snapshot.hotspots.zones) {
      if (!this.visible(zone)) continue;
      const glow = ctx.createRadialGradient(zone.x, zone.y, 0, zone.x, zone.y, zone.radius);
      glow.addColorStop(0, this.theme === "dark" ? "#d7bc7717" : "#c8a65420");
      glow.addColorStop(1, this.theme === "dark" ? "#d7bc7702" : "#c8a65403");
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(zone.x, zone.y, zone.radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.save();
      ctx.strokeStyle = this.theme === "dark" ? "#bfa86a66" : "#9e823c88";
      ctx.lineWidth = 1 / camera.zoom;
      ctx.setLineDash([5 / camera.zoom, 8 / camera.zoom]);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.textAlign = "center";
      ctx.fillStyle = this.theme === "dark" ? "#d7bc77" : "#806729";
      ctx.font = `${10 / camera.zoom}px 'Microsoft YaHei', sans-serif`;
      ctx.fillText(`微光富集区 ${zone.label}`, zone.x, zone.y - zone.radius + 24 / camera.zoom);
      ctx.restore();
    }
  }

  drawSpikes(snapshot, colors) {
    const { ctx, camera } = this;
    for (const spike of snapshot.spikes || []) {
      if (!this.visible(spike)) continue;
      ctx.save();
      ctx.translate(spike.x, spike.y);
      ctx.fillStyle = spike.color || (this.theme === "dark" ? "#72c98e" : "#3f9860");
      ctx.strokeStyle = this.theme === "dark" ? "#c2f0cf" : "#24633c";
      ctx.globalAlpha = 0.92;
      ctx.lineWidth = 1.5 / camera.zoom;
      ctx.beginPath();
      const radius = spike.radius || 58;
      const points = 12;
      for (let i = 0; i < points; i++) {
        const angle = -Math.PI / 2 + i * Math.PI * 2 / points;
        const length = i % 2 ? radius * 0.72 : radius;
        const x = Math.cos(angle) * length;
        const y = Math.sin(angle) * length;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fill();
      ctx.stroke();
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.arc(0, 0, radius * 0.48, 0, Math.PI * 2);
      ctx.fillStyle = colors.background;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = this.theme === "dark" ? "#153d25" : "#123b20";
      ctx.font = `600 ${12 / camera.zoom}px 'Microsoft YaHei', sans-serif`;
      ctx.fillText(spike.projectile ? "反击刺" : `${spike.charge || 0}/${CONFIG.spikes.feedCount}`, 0, 0);
      if (!spike.projectile && spike.charge) {
        ctx.strokeStyle = "#f6db91";
        ctx.lineWidth = 3 / camera.zoom;
        ctx.beginPath();
        ctx.arc(0, 0, radius + 6 / camera.zoom, -Math.PI / 2,
          -Math.PI / 2 + Math.PI * 2 * spike.charge / CONFIG.spikes.feedCount);
        ctx.stroke();
      }
      ctx.restore();
    }
  }

  drawCombatRings(snapshot) {
    const { ctx, camera } = this;
    ctx.save();
    ctx.lineWidth = 2 / camera.zoom;
    for (const ring of this.combat.rings.slice(-this.quality.preset.rings)) {
      ctx.globalAlpha = Math.max(0, ring.life / ring.duration) * .7;
      ctx.strokeStyle = ring.bad ? "#eb9a91" : ring.color || "#b4efcc";
      ctx.beginPath();
      ctx.arc(ring.x, ring.y, (this.reducedMotion ? 20 : 12 + (1 - ring.life / ring.duration) * 42) / camera.zoom, 0, Math.PI * 2);
      ctx.stroke();
    }
    const danger = nearestDanger(snapshot);
    if (danger) {
      const { cell, enemy } = danger;
      const angle = Math.atan2(enemy.y - cell.y, enemy.x - cell.x);
      const cellRadius = this.displayRadius(cell);
      ctx.globalAlpha = .8; ctx.strokeStyle = "#e79b8e"; ctx.lineWidth = 3 / camera.zoom;
      ctx.beginPath();
      ctx.arc(cell.x, cell.y, cellRadius + 9 / camera.zoom, angle - .65, angle + .65);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawCombatText(colors) {
    const { ctx } = this;
    ctx.save();
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    for (const item of this.combat.floats) {
      const point = this.camera.worldToScreen(item);
      ctx.globalAlpha = Math.min(1, Math.max(0, item.life / item.duration) * 2);
      ctx.font = `${item.small ? 500 : 700} ${item.small ? 12 : 17}px 'Microsoft YaHei', sans-serif`;
      const y = point.y - 18 - (this.reducedMotion ? 0 : (1 - item.life / item.duration) * 30);
      ctx.strokeStyle = colors.background; ctx.lineWidth = 4;
      ctx.strokeText(item.text, point.x, y);
      ctx.fillStyle = item.bad ? (this.theme === "dark" ? "#f0a69b" : "#a94138") :
        item.color || colors.player;
      ctx.fillText(item.text, point.x, y);
    }
    ctx.restore();
  }

  drawGrid(bounds, colors) {
    const { ctx, camera } = this;
    const left = Math.max(0, camera.x - this.width / (2 * camera.zoom));
    const top = Math.max(0, camera.y - this.height / (2 * camera.zoom));
    const right = Math.min(bounds.width, camera.x + this.width / (2 * camera.zoom));
    const bottom = Math.min(bounds.height, camera.y + this.height / (2 * camera.zoom));
    ctx.strokeStyle = colors.grid;
    ctx.lineWidth = 0.6 / camera.zoom;
    ctx.globalAlpha = 0.52;
    ctx.beginPath();
    for (let x = Math.floor(left / 50) * 50; this.quality.preset.grid && x < right; x += 50) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (let y = Math.floor(top / 50) * 50; this.quality.preset.grid && y < bottom; y += 50) {
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, bounds.width, bounds.height);
  }

  drawBall(ball, snapshot, colors, drawFill = true) {
    const { ctx } = this;
    const radius = this.displayRadius(ball);
    const protectedPlayer = snapshot.survival ? snapshot.survival.protectionByOwner[ball.ownerId] > 0 :
      ball.isPlayer && snapshot.protectionRemaining > 0;
    const fill = snapshot.team ? ball.color : ball.isPlayer ? colors.player : ball.color;
    ctx.save();
    if (drawFill) {
      ctx.fillStyle = fill;
      ctx.globalAlpha = ball.isPlayer ? 1 : 0.88;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    if (ball.isAlly || (snapshot.team && ball.isPlayer)) {
      ctx.strokeStyle = snapshot.team.color;
      ctx.lineWidth = (ball.isPlayer ? 2.5 : 1.5) / this.camera.zoom;
      ctx.setLineDash(ball.isPlayer ? [] : [5 / this.camera.zoom, 4 / this.camera.zoom]);
      ctx.beginPath(); ctx.arc(ball.x, ball.y, radius + 5, 0, Math.PI * 2); ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.strokeStyle = fill;
    ctx.lineWidth = 1;
    ctx.globalAlpha = ball.isPlayer && snapshot.sprint.active ? 0.75 : 0.18;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, radius + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (protectedPlayer) {
      ctx.strokeStyle = colors.player;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, radius + 11, snapshot.elapsed, snapshot.elapsed + Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    this.drawItemAura(ball, snapshot, radius);
    if (ball.isPlayer && snapshot.playerCells.length > 1) {
      ctx.strokeStyle = colors.player;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const progress = 1 - ball.mergeRemaining / CONFIG.split.mergeDelay;
      ctx.arc(ball.x, ball.y, radius + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, progress));
      ctx.stroke();
      ctx.globalAlpha = 1;
      // 当前最大分身再加一圈细高亮，8 球状态下能快速看出分裂预算来自哪一球。
      if (ball.id === snapshot.player.id) {
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, radius + 13, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = colors.playerInk;
    ctx.font = `500 ${Math.max(10, Math.min(19, radius * 0.4))}px 'Microsoft YaHei', sans-serif`;
    ctx.fillText(ball.name, ball.x, ball.y, radius * 1.7);
    ctx.restore();
  }

  drawItemAura(ball, snapshot, radius) {
    const effects = snapshot.items?.effects?.[ball.ownerId];
    if (!effects) return;
    const active = type => (effects[type] ?? 0) > snapshot.elapsed;
    const { ctx, camera } = this;
    const rotation = this.reducedMotion ? 0 : snapshot.elapsed * 1.4;
    if (active("shield")) {
      ctx.save();
      ctx.strokeStyle = "#82b8d8";
      ctx.lineWidth = 3 / camera.zoom;
      ctx.globalAlpha = .88;
      ctx.setLineDash([10 / camera.zoom, 5 / camera.zoom]);
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, radius + 9 / camera.zoom, rotation, rotation + Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = .28;
      ctx.lineWidth = 7 / camera.zoom;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, radius + 9 / camera.zoom, rotation, rotation + Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (active("magnet")) {
      ctx.save();
      ctx.strokeStyle = "#d7bc77";
      ctx.globalAlpha = .42;
      ctx.lineWidth = 1.25 / camera.zoom;
      ctx.setLineDash([2 / camera.zoom, 7 / camera.zoom]);
      ctx.lineDashOffset = -rotation * 7;
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, radius + 14 / camera.zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
    if (active("speed")) {
      ctx.save();
      ctx.strokeStyle = "#dd8f82";
      ctx.globalAlpha = .78;
      ctx.lineWidth = 2 / camera.zoom;
      for (let index = 0; index < 3; index++) {
        const start = rotation * 1.8 + index * Math.PI * 2 / 3;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, radius + 6 / camera.zoom, start, start + .34);
        ctx.stroke();
      }
      ctx.restore();
    }
    if (active("cloak")) {
      ctx.save();
      ctx.strokeStyle = "#b2a4dc";
      ctx.globalAlpha = .72;
      ctx.lineWidth = 1.5 / camera.zoom;
      ctx.setLineDash([3 / camera.zoom, 5 / camera.zoom]);
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, radius + 18 / camera.zoom, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }

  dispose() {
    this.unsubscribeVisuals?.();
    this.resizeObserver?.disconnect();
    this.particlePool.clear();
    this.fluidRenderer.dispose();
  }

  drawBallLabels(balls, snapshot, colors) {
    const { ctx } = this;
    ctx.save();
    const circles = balls.map(ball => {
      const point = this.camera.worldToScreen(ball);
      const halo = ball.isPlayer && snapshot.protectionRemaining > 0 ? 11 : 5;
      return { id: ball.id, ...point, radius: (this.displayRadius(ball) + halo) * this.camera.zoom };
    });
    const labels = balls.map((ball, index) => {
      const description = describeBallLabel(ball, snapshot, this.camera.zoom);
      const font = `${ball.isPlayer ? 10 : 9}px 'Microsoft YaHei', sans-serif`;
      ctx.font = font;
      return { ...circles[index], ...description, isPlayer: ball.isPlayer, font,
        width: ctx.measureText(description.text).width + 10, height: ball.isPlayer ? 18 : 17 };
    });
    const mini = this.getMiniMapBounds(snapshot);
    const obstacles = [...this.labelObstacles,
      { left: mini.x - 8, right: mini.x + mini.width + 8, top: mini.y - 19, bottom: mini.y + mini.height + 8 }];
    this.labelPlacements = layoutBallLabels(labels, { width: this.width, height: this.height, circles, obstacles });
    // 引线从球边缘出发；先画线再盖文字底板，避免穿过文字或误认到其他分身。
    for (const label of this.labelPlacements) {
      if (!label.linked) continue;
      const dx = label.x - label.anchor.x;
      const dy = label.y - label.anchor.y;
      const distance = Math.hypot(dx, dy);
      if (distance <= label.radius + 4) continue;
      const nx = dx / distance;
      const ny = dy / distance;
      const inset = Math.min(label.width / 2 / Math.max(Math.abs(nx), 0.001), label.height / 2 / Math.max(Math.abs(ny), 0.001));
      ctx.strokeStyle = label.isPlayer ? colors.player : colors.muted;
      ctx.globalAlpha = 0.4;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.moveTo(label.anchor.x + nx * (label.radius + 2), label.anchor.y + ny * (label.radius + 2));
      ctx.lineTo(label.x - nx * (inset + 2), label.y - ny * (inset + 2));
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    for (const label of this.labelPlacements) {
      ctx.fillStyle = this.theme === "dark" ? "#101a17dd" : "#f4f8f0e8";
      ctx.beginPath();
      ctx.roundRect(label.rect.left, label.rect.top, label.width, label.height, 4);
      ctx.fill();
      ctx.font = label.font;
      ctx.fillStyle = label.dangerous ? (this.theme === "dark" ? "#cda092" : "#9e5d4a") : colors.muted;
      ctx.fillText(label.text, label.x, label.y);
    }
    ctx.restore();
  }

  getMiniMapBounds(snapshot) {
    const width = this.width < 500 ? 96 : 119;
    const height = width * snapshot.bounds.height / snapshot.bounds.width;
    const x = this.width - width - 16;
    const y = this.height - height - (this.touchMode && snapshot.state === "playing" && !snapshot.spectating ? 225 : 18);
    const sx = width / snapshot.bounds.width;
    const sy = height / snapshot.bounds.height;
    return { x, y, width, height, sx, sy };
  }

  drawMiniMap(snapshot, colors, feedback) {
    const { ctx } = this;
    const { x, y, width, height, sx, sy } = this.getMiniMapBounds(snapshot);
    ctx.fillStyle = colors.mini;
    ctx.strokeStyle = colors.miniBorder;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(x - 8, y - 19, width + 16, height + 27, 6);
    ctx.fill();
    ctx.stroke();
    ctx.font = "8px Consolas, monospace";
    ctx.fillStyle = colors.muted;
    ctx.fillText("WORLD MAP", x, y - 7);
    ctx.strokeStyle = colors.grid;
    ctx.strokeRect(x, y, width, height);
    // 视野框和实体点使缩放后的位置仍然容易理解。
    const viewWidth = Math.min(width, this.width / this.camera.zoom * sx);
    const viewHeight = Math.min(height, this.height / this.camera.zoom * sy);
    const viewX = Math.max(x, Math.min(x + width - viewWidth, x + this.camera.x * sx - viewWidth / 2));
    const viewY = Math.max(y, Math.min(y + height - viewHeight, y + this.camera.y * sy - viewHeight / 2));
    ctx.fillStyle = this.theme === "dark" ? "#b4efcc0c" : "#357c5210";
    ctx.fillRect(viewX, viewY, viewWidth, viewHeight);
    ctx.strokeStyle = colors.miniBorder;
    ctx.strokeRect(viewX, viewY, viewWidth, viewHeight);
    ctx.save();
    ctx.strokeStyle = this.theme === "dark" ? "#d7bc77" : "#92752e";
    ctx.fillStyle = ctx.strokeStyle;
    ctx.font = "8px Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const highlight = (feedback?.hotspots.highlightRemaining ?? 0) / CONFIG.feedback.hotspotHighlightSeconds;
    const warning = feedback?.hotspots.phase === "warning";
    for (const zone of snapshot.hotspots.zones) {
      const zx = x + zone.x * sx;
      const zy = y + zone.y * sy;
      const radius = zone.radius * sx;
      if (highlight > 0) {
        ctx.globalAlpha = 0.24 * highlight;
        ctx.beginPath();
        ctx.arc(zx, zy, radius + 3, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.85 * highlight;
        ctx.lineWidth = 1.6;
        ctx.beginPath();
        const expansion = this.reducedMotion ? 3 : 3 + (1 - highlight) * 5;
        ctx.arc(zx, zy, radius + expansion, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = warning || highlight > 0 ? 1 : 0.8;
      ctx.lineWidth = warning || highlight > 0 ? 1.6 : 1;
      ctx.beginPath();
      ctx.arc(zx, zy, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.fillText(zone.label, zx, zy);
    }
    ctx.restore();
    this.drawMiniTactics(snapshot, { x, y, width, height, sx, sy });
    for (const bot of snapshot.bots) {
      ctx.fillStyle = bot.color;
      ctx.globalAlpha = 0.7;
      ctx.beginPath();
      ctx.arc(x + bot.x * sx, y + bot.y * sy, 1.7, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const spike of snapshot.spikes || []) {
      ctx.fillStyle = this.theme === "dark" ? "#72c98e" : "#3f9860";
      ctx.globalAlpha = 0.9;
      ctx.beginPath();
      ctx.arc(x + spike.x * sx, y + spike.y * sy, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }
    for (const item of snapshot.items?.items || []) {
      ctx.fillStyle = item.color || "#d7bc77";
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(x + item.x * sx, y + item.y * sy, 1.9, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    for (const cell of snapshot.playerCells) {
      ctx.fillStyle = snapshot.team ? snapshot.team.color : colors.player;
      ctx.beginPath();
      ctx.arc(x + cell.x * sx, y + cell.y * sy, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawDirection(snapshot, colors) {
    for (const player of snapshot.playerCells) this.drawCellDirection(player, colors);
  }

  drawMiniTactics(snapshot, map) {
    const { ctx } = this, { x, y, width, height, sx, sy } = map;
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, width, height); ctx.clip();
    if (snapshot.safeZone) {
      const zone = snapshot.safeZone;
      ctx.strokeStyle = this.theme === 'dark' ? '#c5a5eb' : '#8151aa'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x + zone.x * sx, y + zone.y * sy, zone.radius * sx, 0, Math.PI * 2); ctx.stroke();
      if (['warning', 'shrinking'].includes(zone.phase)) {
        ctx.strokeStyle = '#cda45b'; ctx.setLineDash([3, 2]);
        ctx.beginPath(); ctx.arc(x + zone.x * sx, y + zone.y * sy, zone.nextRadius * sx, 0, Math.PI * 2); ctx.stroke();
      }
    }
    ctx.setLineDash([]);
    for (const ping of snapshot.pings || []) {
      ctx.fillStyle = SIGNAL_COLORS[ping.kind];
      const px = x + ping.x * sx, py = y + ping.y * sy;
      ctx.beginPath(); ctx.moveTo(px, py - 4); ctx.lineTo(px + 4, py); ctx.lineTo(px, py + 4); ctx.lineTo(px - 4, py); ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  drawCellDirection(player, colors) {
    const speed = Math.hypot(player.vx, player.vy);
    if (speed < 15) return;
    const point = this.camera.worldToScreen(player);
    const angle = Math.atan2(player.vy, player.vx);
    const distance = this.displayRadius(player) * this.camera.zoom + 15;
    const { ctx } = this;
    ctx.save();
    ctx.translate(point.x, point.y);
    ctx.rotate(angle);
    ctx.fillStyle = colors.player;
    ctx.globalAlpha = 0.45;
    ctx.beginPath();
    ctx.moveTo(distance + 5, 0);
    ctx.lineTo(distance, -3);
    ctx.lineTo(distance, 3);
    ctx.fill();
    ctx.restore();
  }
}
