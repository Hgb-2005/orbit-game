import { CONFIG } from "./config.js";
import { describeBallLabel, layoutBallLabels } from "./presentation/labels.js";

const THEMES = {
  dark: { background: "#101a17", grid: "#26342b", border: "#586f5e", text: "#d6e0d9", muted: "#718979", player: "#b4efcc", playerInk: "#203d2a", mini: "#15211ce8", miniBorder: "#334539" },
  light: { background: "#eaf0e8", grid: "#d1ddce", border: "#90aa92", text: "#3a523d", muted: "#6f8a71", player: "#78ba8b", playerInk: "#153e22", mini: "#f4f8f0ed", miniBorder: "#b6cbb5" },
};

/** Canvas 只读取状态，所有坐标都使用世界坐标，最后由相机统一变换。 */
export class Renderer {
  constructor(canvas, camera) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.camera = camera;
    this.theme = "dark";
    this.width = 1;
    this.height = 1;
    this.particles = [];
    this.trails = [];
    this.trailTimer = 0;
    this.labelObstacles = [];
    this.labelPlacements = [];
    this.reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
  }

  addEvents(events) {
    for (const event of events) {
      if (!["food", "eat", "sprint", "split", "merge", "celllost", "respawn", "spore", "spore-eat", "spike"].includes(event.type)) continue;
      if (event.type === "respawn" && !event.isPlayer) continue;
      const count = event.type === "food" ? 4 : 15;
      for (let i = 0; i < count; i++) {
        if (this.particles.length > 180) this.particles.shift();
        const angle = Math.random() * Math.PI * 2;
        const speed = 15 + Math.random() * 55;
        this.particles.push({ x: event.x, y: event.y, vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed, life: 0.5, color: event.color });
      }
    }
  }

  resetEffects() {
    this.particles = [];
    this.trails = [];
    this.trailTimer = 0;
  }

  draw(snapshot, dt, feedback) {
    const { ctx, camera } = this;
    const colors = THEMES[this.theme];
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = colors.background;
    ctx.fillRect(0, 0, this.width, this.height);
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

    if (snapshot.state === "playing") {
      this.trailTimer += dt;
      for (const trail of this.trails) trail.life -= dt;
      if (snapshot.sprint.active && !this.reducedMotion && this.trailTimer > 0.035) {
        this.trailTimer = 0;
        for (const cell of snapshot.playerCells) {
          this.trails.push({ x: cell.x, y: cell.y, radius: cell.radius, life: 0.3 });
        }
      }
      this.trails = this.trails.filter(trail => trail.life > 0);
    }
    ctx.fillStyle = colors.player;
    for (const trail of this.trails) {
      ctx.globalAlpha = Math.max(0, trail.life / 0.3) * 0.16;
      ctx.beginPath();
      ctx.arc(trail.x, trail.y, trail.radius * 0.88, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    const balls = [...snapshot.bots, ...snapshot.playerCells].filter(ball => ball.alive).sort((a, b) => a.mass - b.mass);
    for (const ball of balls) {
      if (this.visible(ball)) this.drawBall(ball, snapshot, colors);
    }

    for (const particle of this.particles) {
      if (snapshot.state === "playing") {
        particle.life -= dt;
        particle.x += particle.vx * dt;
        particle.y += particle.vy * dt;
      }
      ctx.globalAlpha = Math.max(0, particle.life / 0.5);
      ctx.fillStyle = particle.color;
      ctx.fillRect(particle.x - 1.5, particle.y - 1.5, 3, 3);
    }
    this.particles = this.particles.filter(particle => particle.life > 0);
    ctx.globalAlpha = 1;
    ctx.restore();
    if (snapshot.state === "playing") this.drawDirection(snapshot, colors);
    this.drawBallLabels(balls.filter(ball => this.visible(ball)), snapshot, colors);
    this.drawMiniMap(snapshot, colors, feedback);
  }

  visible(entity) {
    const point = this.camera.worldToScreen(entity);
    const radius = entity.radius * this.camera.zoom + 35;
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
      ctx.restore();
    }
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
    for (let x = Math.floor(left / 50) * 50; x < right; x += 50) {
      ctx.moveTo(x, top);
      ctx.lineTo(x, bottom);
    }
    for (let y = Math.floor(top / 50) * 50; y < bottom; y += 50) {
      ctx.moveTo(left, y);
      ctx.lineTo(right, y);
    }
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.border;
    ctx.lineWidth = 3;
    ctx.strokeRect(0, 0, bounds.width, bounds.height);
  }

  drawBall(ball, snapshot, colors) {
    const { ctx } = this;
    const protectedPlayer = snapshot.survival ? snapshot.survival.protectionByOwner[ball.ownerId] > 0 :
      ball.isPlayer && snapshot.protectionRemaining > 0;
    const fill = ball.isPlayer ? colors.player : ball.color;
    ctx.save();
    ctx.fillStyle = fill;
    ctx.globalAlpha = ball.isPlayer ? 1 : 0.88;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = fill;
    ctx.lineWidth = 1;
    ctx.globalAlpha = ball.isPlayer && snapshot.sprint.active ? 0.75 : 0.18;
    ctx.beginPath();
    ctx.arc(ball.x, ball.y, ball.radius + 5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (protectedPlayer) {
      ctx.strokeStyle = colors.player;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.arc(ball.x, ball.y, ball.radius + 11, snapshot.elapsed, snapshot.elapsed + Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    if (ball.isPlayer && snapshot.playerCells.length > 1) {
      ctx.strokeStyle = colors.player;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = 2;
      ctx.beginPath();
      const progress = 1 - ball.mergeRemaining / CONFIG.split.mergeDelay;
      ctx.arc(ball.x, ball.y, ball.radius + 8, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.max(0, progress));
      ctx.stroke();
      ctx.globalAlpha = 1;
      // 当前最大分身再加一圈细高亮，8 球状态下能快速看出分裂预算来自哪一球。
      if (ball.id === snapshot.player.id) {
        ctx.globalAlpha = 0.9;
        ctx.lineWidth = 1.2;
        ctx.beginPath();
        ctx.arc(ball.x, ball.y, ball.radius + 13, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = 1;
      }
    }
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillStyle = colors.playerInk;
    ctx.font = `500 ${Math.max(10, Math.min(19, ball.radius * 0.4))}px 'Microsoft YaHei', sans-serif`;
    ctx.fillText(ball.name, ball.x, ball.y, ball.radius * 1.7);
    ctx.restore();
  }

  drawBallLabels(balls, snapshot, colors) {
    const { ctx } = this;
    ctx.save();
    const circles = balls.map(ball => {
      const point = this.camera.worldToScreen(ball);
      const halo = ball.isPlayer && snapshot.protectionRemaining > 0 ? 11 : 5;
      return { id: ball.id, ...point, radius: (ball.radius + halo) * this.camera.zoom };
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
    const y = this.height - height - 18;
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
    ctx.globalAlpha = 1;
    for (const cell of snapshot.playerCells) {
      ctx.fillStyle = colors.player;
      ctx.beginPath();
      ctx.arc(x + cell.x * sx, y + cell.y * sy, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  drawDirection(snapshot, colors) {
    for (const player of snapshot.playerCells) this.drawCellDirection(player, colors);
  }

  drawCellDirection(player, colors) {
    const speed = Math.hypot(player.vx, player.vy);
    if (speed < 15) return;
    const point = this.camera.worldToScreen(player);
    const angle = Math.atan2(player.vy, player.vx);
    const distance = player.radius * this.camera.zoom + 15;
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
