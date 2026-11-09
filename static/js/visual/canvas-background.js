function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

const DARK = { background: "#101a17", glow: "#6caa84", accent: "#d6bd7c", dust: "#c7ddd0" };
const LIGHT = { background: "#eaf0e8", glow: "#8ec49e", accent: "#b18a40", dust: "#58735f" };

/** Canvas 兜底背景；与 WebGL 背景使用同一组模式，但保持低绘制成本。 */
export class CanvasBackground {
  constructor() {
    this.width = 0;
    this.height = 0;
    this.stars = [];
  }

  resize(width, height) {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));
    const random = mulberry32(0x0b17);
    const count = Math.min(180, Math.max(42, Math.round(this.width * this.height / 7600)));
    this.stars = Array.from({ length: count }, () => ({
      x: random(), y: random(), size: .45 + random() * 1.65, depth: .25 + random() * .75, phase: random() * Math.PI * 2,
    }));
  }

  draw(ctx, options) {
    const { width, height, mode = "stars", theme = "dark", time = 0, camera = null,
      audio = 0, reducedMotion = false } = options;
    const colors = theme === "light" ? LIGHT : DARK;
    ctx.save();
    const gradient = ctx.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, colors.background);
    gradient.addColorStop(1, theme === "light" ? "#dfe9df" : "#0b1211");
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
    if (mode === "dark") {
      ctx.restore();
      return;
    }
    if (mode === "stars") this.drawStars(ctx, colors, time, reducedMotion, camera);
    else if (mode === "ring") this.drawRing(ctx, colors, time, audio, reducedMotion);
    else if (mode === "galaxy") this.drawGalaxy(ctx, colors, time, audio, reducedMotion);
    else if (mode === "mountain") this.drawMountain(ctx, colors, height, camera, time);
    else if (mode === "blackhole") this.drawBlackHole(ctx, colors, time, audio, reducedMotion);
    ctx.restore();
  }

  drawStars(ctx, colors, time, reducedMotion, camera) {
    if (this.stars.length === 0) this.resize(this.width, this.height);
    const camX = camera?.x ?? 0, camY = camera?.y ?? 0;
    ctx.fillStyle = colors.dust;
    for (const star of this.stars) {
      const x = (star.x * this.width - camX * .006 * star.depth + this.width) % this.width;
      const y = (star.y * this.height - camY * .006 * star.depth + this.height) % this.height;
      const twinkle = reducedMotion ? .7 : .48 + Math.sin(time * (.35 + star.depth) + star.phase) * .28;
      ctx.globalAlpha = twinkle * (.22 + star.depth * .55);
      ctx.fillRect(x, y, star.size, star.size);
    }
    ctx.globalAlpha = 1;
  }

  drawRing(ctx, colors, time, audio, reducedMotion) {
    const cx = this.width * .64, cy = this.height * .44;
    const pulse = reducedMotion ? 0 : Math.sin(time * .45) * .035 + audio * .05;
    const glow = ctx.createRadialGradient(cx, cy, 5, cx, cy, Math.max(this.width, this.height) * .62);
    glow.addColorStop(0, `${colors.glow}18`);
    glow.addColorStop(.5, `${colors.glow}0b`);
    glow.addColorStop(1, `${colors.glow}00`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(-.28);
    for (let index = 0; index < 6; index++) {
      ctx.strokeStyle = index % 2 ? `${colors.accent}30` : `${colors.glow}2e`;
      ctx.lineWidth = 1 + index * .65;
      ctx.beginPath();
      ctx.ellipse(0, 0, this.width * (.18 + index * .065 + pulse), this.height * (.08 + index * .027),
        .08 * index, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.restore();
  }

  drawGalaxy(ctx, colors, time, audio, reducedMotion) {
    const random = mulberry32(0x9a11);
    const cx = this.width * .52, cy = this.height * .52;
    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, this.width * .62);
    glow.addColorStop(0, `${colors.glow}${Math.round(18 + audio * 24).toString(16).padStart(2, "0")}`);
    glow.addColorStop(.38, `${colors.accent}10`);
    glow.addColorStop(1, `${colors.glow}00`);
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, this.width, this.height);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(reducedMotion ? 0 : time * .018);
    for (let index = 0; index < 190; index++) {
      const angle = random() * Math.PI * 2;
      const radius = Math.pow(random(), .58) * this.width * .42;
      const x = Math.cos(angle) * radius;
      const y = Math.sin(angle) * radius * .36;
      ctx.globalAlpha = .12 + random() * .38;
      ctx.fillStyle = index % 5 ? colors.dust : colors.accent;
      ctx.fillRect(x, y, .7 + random() * 2, .7 + random() * 2);
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  }

  drawMountain(ctx, colors, height, camera, time) {
    const offset = (camera?.x ?? 0) * .035;
    const layers = [
      { y: height * .68, amp: height * .18, color: colors.glow, alpha: .07, frequency: .0031 },
      { y: height * .78, amp: height * .14, color: colors.dust, alpha: .08, frequency: .0047 },
      { y: height * .91, amp: height * .1, color: colors.background, alpha: .55, frequency: .0062 },
    ];
    ctx.save();
    ctx.beginPath();
    ctx.arc(this.width * .75, height * .23, Math.min(this.width, height) * .09, 0, Math.PI * 2);
    ctx.fillStyle = `${colors.accent}20`;
    ctx.fill();
    for (const [index, layer] of layers.entries()) {
      ctx.beginPath();
      ctx.moveTo(0, height);
      for (let x = 0; x <= this.width + 16; x += 16) {
        const ridge = Math.abs(Math.sin((x + offset * (index + 1)) * layer.frequency)) * layer.amp;
        const wave = Math.sin((x - offset * 1.5) * layer.frequency * .41 + time * .015 * (index + 1)) * 10;
        ctx.lineTo(x, layer.y - ridge + wave);
      }
      ctx.lineTo(this.width, height);
      ctx.closePath();
      ctx.globalAlpha = layer.alpha;
      ctx.fillStyle = layer.color;
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  drawBlackHole(ctx, colors, time, audio, reducedMotion) {
    const cx = this.width * .53, cy = this.height * .48;
    const radius = Math.min(this.width, this.height) * (.16 + audio * .018);
    ctx.save();
    ctx.translate(cx, cy);
    const glow = ctx.createRadialGradient(0, 0, radius * .7, 0, 0, radius * 2.2);
    glow.addColorStop(0, themeAlpha(colors.accent, .24));
    glow.addColorStop(.42, themeAlpha(colors.glow, .1));
    glow.addColorStop(1, themeAlpha(colors.glow, 0));
    ctx.fillStyle = glow;
    ctx.fillRect(-radius * 2.3, -radius * 2.3, radius * 4.6, radius * 4.6);
    ctx.rotate(reducedMotion ? 0 : time * .09);
    for (let index = 0; index < 5; index++) {
      ctx.strokeStyle = themeAlpha(index % 2 ? colors.accent : colors.glow, .3 - index * .035);
      ctx.lineWidth = 1.5 + index * .6;
      ctx.beginPath();
      ctx.ellipse(0, 0, radius * (1.24 + index * .13), radius * (.38 + index * .07), index * .38, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.fillStyle = "#08100ddd";
    ctx.beginPath();
    ctx.arc(0, 0, radius, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }
}

function themeAlpha(hex, alpha) {
  const value = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, "0");
  return `${hex}${value}`;
}
