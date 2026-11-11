import { getBallSkin, getSporeSkin, normalizeAppearance, normalizeSporeSkin } from "./catalog.js";

const TAU = Math.PI * 2;
const hash = value => [...String(value ?? "")].reduce((sum, char) => (sum * 31 + char.charCodeAt(0)) >>> 0, 7);
const motionTime = (time, reducedMotion) => reducedMotion ? 0 : Number(time) || 0;

function withAlpha(color, alpha) {
  const hex = String(color || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(hex)) return color || `rgba(255,255,255,${alpha})`;
  const [r, g, b] = [0, 2, 4].map(offset => parseInt(hex.slice(offset, offset + 2), 16));
  return `rgba(${r},${g},${b},${alpha})`;
}

function drawHighlight(ctx, radius) {
  ctx.save();
  ctx.globalAlpha = 0.34;
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  ctx.ellipse(-radius * .28, -radius * .34, radius * .28, radius * .16, -.55, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawOrbit(ctx, radius, accent, secondary, phase, detail) {
  ctx.save();
  ctx.rotate(-.34 + Math.sin(phase * .55) * .08);
  ctx.strokeStyle = withAlpha(accent, .72);
  ctx.lineWidth = Math.max(1, radius * .055);
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * .7, radius * .32, .18, 0, TAU);
  ctx.stroke();
  if (detail > .5) {
    const x = Math.cos(phase * .7) * radius * .69;
    const y = Math.sin(phase * .7) * radius * .31;
    ctx.fillStyle = secondary;
    ctx.beginPath();
    ctx.arc(x, y, Math.max(1.4, radius * .09), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawWaves(ctx, radius, accent, phase, detail) {
  ctx.save();
  ctx.strokeStyle = withAlpha(accent, .72);
  ctx.lineCap = "round";
  const lines = detail > .55 ? 4 : 2;
  for (let index = 0; index < lines; index++) {
    const y = radius * (-.52 + index * .34);
    const amplitude = radius * (.09 + index * .015);
    ctx.lineWidth = Math.max(1, radius * .045);
    ctx.beginPath();
    for (let step = 0; step <= 18; step++) {
      const x = -radius + step / 18 * radius * 2;
      const wave = Math.sin(step * .72 + phase * 1.25 + index) * amplitude;
      if (step) ctx.lineTo(x, y + wave); else ctx.moveTo(x, y + wave);
    }
    ctx.stroke();
  }
  ctx.restore();
}

function drawSun(ctx, radius, accent, secondary, phase, detail) {
  ctx.save();
  const glow = ctx.createRadialGradient(-radius * .18, -radius * .12, radius * .04, 0, 0, radius);
  glow.addColorStop(0, withAlpha(secondary, .72));
  glow.addColorStop(.58, withAlpha(accent, .18));
  glow.addColorStop(1, withAlpha(accent, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(-radius, -radius, radius * 2, radius * 2);
  ctx.strokeStyle = withAlpha(accent, .48);
  ctx.lineWidth = Math.max(1, radius * .035);
  const rays = detail > .55 ? 10 : 6;
  for (let index = 0; index < rays; index++) {
    const angle = index / rays * TAU + phase * .08;
    ctx.beginPath();
    ctx.moveTo(Math.cos(angle) * radius * .42, Math.sin(angle) * radius * .42);
    ctx.lineTo(Math.cos(angle) * radius * .73, Math.sin(angle) * radius * .73);
    ctx.stroke();
  }
  ctx.restore();
}

function drawNebula(ctx, radius, accent, secondary, seed, detail) {
  const blobs = detail > .55 ? 5 : 3;
  ctx.save();
  ctx.globalCompositeOperation = "screen";
  for (let index = 0; index < blobs; index++) {
    const angle = seed * .0007 + index / blobs * TAU;
    const distance = radius * (.17 + (index % 2) * .12);
    const x = Math.cos(angle) * distance;
    const y = Math.sin(angle) * distance;
    const size = radius * (.2 + (index % 3) * .055);
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, size);
    gradient.addColorStop(0, withAlpha(index % 2 ? secondary : accent, .58));
    gradient.addColorStop(1, withAlpha(index % 2 ? secondary : accent, 0));
    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.arc(x, y, size, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = withAlpha(secondary, .9);
  for (let index = 0; index < (detail > .55 ? 5 : 3); index++) {
    const angle = seed * .0013 + index * 2.3;
    const distance = radius * (.16 + ((index * 23) % 60) / 100);
    ctx.beginPath();
    ctx.arc(Math.cos(angle) * distance, Math.sin(angle) * distance, Math.max(.8, radius * .026), 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}

function drawPixels(ctx, radius, accent, secondary, detail) {
  const cell = radius / (detail > .55 ? 4.6 : 3.2);
  ctx.save();
  ctx.globalAlpha = .56;
  for (let row = -4; row <= 4; row++) {
    for (let column = -4; column <= 4; column++) {
      if ((row * 5 + column * 3) % 4 === 0) continue;
      if (Math.hypot((column + .5) * cell, (row + .5) * cell) > radius * .88) continue;
      ctx.fillStyle = (row + column) % 3 === 0 ? secondary : accent;
      const gap = Math.max(1, cell * .16);
      ctx.fillRect(column * cell + gap, row * cell + gap, cell - gap * 2, cell - gap * 2);
    }
  }
  ctx.restore();
}

function drawCitrus(ctx, radius, accent, secondary) {
  ctx.save();
  ctx.rotate(-.48);
  ctx.fillStyle = withAlpha(accent, .42);
  for (let index = -4; index <= 4; index += 2) ctx.fillRect(-radius * 1.4, index * radius * .28, radius * 2.8, radius * .14);
  ctx.fillStyle = withAlpha(secondary, .62);
  ctx.beginPath();
  ctx.arc(radius * .12, 0, radius * .3, 0, TAU);
  ctx.fill();
  ctx.strokeStyle = withAlpha("#fff6d7", .65);
  ctx.lineWidth = Math.max(1, radius * .035);
  for (let index = 0; index < 6; index++) {
    const angle = index / 6 * TAU;
    ctx.beginPath();
    ctx.moveTo(radius * .12, 0);
    ctx.lineTo(radius * .12 + Math.cos(angle) * radius * .26, Math.sin(angle) * radius * .26);
    ctx.stroke();
  }
  ctx.restore();
}

/**
 * 在主画布和所有预览中绘制同一套球面纹样。
 * 纹理始终裁剪在球体内部；体积很小时会自动降低细节。
 */
export function drawBallSkin(ctx, ball, options = {}) {
  const radius = Math.max(0, options.radius ?? ball.radius ?? 0);
  if (!ctx || radius < 4) return;
  const appearance = normalizeAppearance({ ballSkin: ball.ballSkin, sporeSkin: ball.sporeSkin });
  const skin = getBallSkin(appearance.ballSkin);
  const time = motionTime(options.time, options.reducedMotion);
  const detail = Math.max(0, Math.min(1, options.detail ?? (radius < 16 ? .35 : radius < 30 ? .7 : 1)));
  const seed = hash(ball.id);
  const x = ball.x ?? options.x ?? 0;
  const y = ball.y ?? options.y ?? 0;
  ctx.save();
  ctx.translate(x, y);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, TAU);
  ctx.clip();
  drawHighlight(ctx, radius);
  if (skin.motif === "orbit") drawOrbit(ctx, radius, skin.accent, skin.secondary, time + seed * .01, detail);
  else if (skin.motif === "waves") drawWaves(ctx, radius, skin.accent, time + seed * .01, detail);
  else if (skin.motif === "sun") drawSun(ctx, radius, skin.accent, skin.secondary, time + seed * .01, detail);
  else if (skin.motif === "nebula") drawNebula(ctx, radius, skin.accent, skin.secondary, seed, detail);
  else if (skin.motif === "pixel") drawPixels(ctx, radius, skin.accent, skin.secondary, detail);
  else if (skin.motif === "citrus") drawCitrus(ctx, radius, skin.accent, skin.secondary);
  ctx.strokeStyle = withAlpha(options.theme === "light" ? "#203a35" : "#ffffff", .26);
  ctx.lineWidth = Math.max(1, radius * .045);
  ctx.beginPath();
  ctx.arc(0, 0, radius * .94, 0, TAU);
  ctx.stroke();
  ctx.restore();
}

function drawComet(ctx, radius, accent, secondary, spore) {
  const angle = Math.atan2(spore.vy || 0, spore.vx || 1);
  ctx.save();
  ctx.rotate(angle);
  ctx.globalAlpha = .72;
  ctx.fillStyle = secondary;
  ctx.beginPath();
  ctx.moveTo(-radius * .25, -radius * .55);
  ctx.lineTo(-radius * 2.5, 0);
  ctx.lineTo(-radius * .25, radius * .55);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = accent;
  ctx.beginPath();
  ctx.arc(0, 0, radius * .7, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawFlower(ctx, radius, accent, secondary) {
  ctx.save();
  ctx.fillStyle = withAlpha(accent, .9);
  for (let index = 0; index < 4; index++) {
    const angle = index / 4 * TAU;
    ctx.beginPath();
    ctx.ellipse(Math.cos(angle) * radius * .58, Math.sin(angle) * radius * .58,
      radius * .62, radius * .34, angle, 0, TAU);
    ctx.fill();
  }
  ctx.fillStyle = secondary;
  ctx.beginPath();
  ctx.arc(0, 0, radius * .42, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawCrystal(ctx, radius, accent, secondary) {
  ctx.save();
  ctx.rotate(.35);
  ctx.fillStyle = withAlpha(accent, .76);
  for (let index = 0; index < 4; index++) {
    ctx.rotate(Math.PI / 2);
    ctx.beginPath();
    ctx.moveTo(0, -radius * .35);
    ctx.lineTo(radius * .22, -radius * 1.48);
    ctx.lineTo(radius * .44, -radius * .38);
    ctx.closePath();
    ctx.fill();
  }
  ctx.strokeStyle = secondary;
  ctx.lineWidth = Math.max(1, radius * .13);
  ctx.beginPath();
  ctx.moveTo(-radius * .72, 0); ctx.lineTo(radius * .72, 0);
  ctx.moveTo(0, -radius * .72); ctx.lineTo(0, radius * .72);
  ctx.stroke();
  ctx.restore();
}

function drawSporeOrbit(ctx, radius, accent, secondary) {
  ctx.save();
  ctx.rotate(-.4);
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, radius * .22);
  ctx.beginPath();
  ctx.ellipse(0, 0, radius * 1.45, radius * .64, 0, 0, TAU);
  ctx.stroke();
  ctx.fillStyle = secondary;
  ctx.beginPath();
  ctx.arc(radius * 1.3, 0, radius * .34, 0, TAU);
  ctx.fill();
  ctx.restore();
}

function drawZigzag(ctx, radius, accent, secondary) {
  ctx.save();
  ctx.strokeStyle = accent;
  ctx.lineWidth = Math.max(1, radius * .28);
  ctx.lineJoin = "round";
  ctx.beginPath();
  ctx.moveTo(-radius * 1.3, radius * .35);
  ctx.lineTo(-radius * .45, -radius * .5);
  ctx.lineTo(radius * .28, radius * .42);
  ctx.lineTo(radius * 1.2, -radius * .48);
  ctx.stroke();
  ctx.fillStyle = secondary;
  ctx.beginPath();
  ctx.arc(0, 0, radius * .46, 0, TAU);
  ctx.fill();
  ctx.restore();
}

/** 孢子装饰会适度越出主体，提供比纯圆点更清楚的飞行辨识度。 */
export function drawSporeSkin(ctx, spore, options = {}) {
  const radius = Math.max(1, options.radius ?? spore.radius ?? 4);
  const skin = getSporeSkin(normalizeSporeSkin(options.skinId ?? spore.sporeSkin));
  ctx.save();
  ctx.translate(spore.x ?? options.x ?? 0, spore.y ?? options.y ?? 0);
  if (skin.motif === "comet") drawComet(ctx, radius, skin.accent, skin.secondary, spore);
  else if (skin.motif === "flower") drawFlower(ctx, radius, skin.accent, skin.secondary);
  else if (skin.motif === "crystal") drawCrystal(ctx, radius, skin.accent, skin.secondary);
  else if (skin.motif === "orbit") drawSporeOrbit(ctx, radius, skin.accent, skin.secondary);
  else if (skin.motif === "zigzag") drawZigzag(ctx, radius, skin.accent, skin.secondary);
  else {
    ctx.fillStyle = withAlpha(skin.secondary, .9);
    ctx.beginPath();
    ctx.ellipse(-radius * .25, -radius * .3, radius * .34, radius * .5, -.6, 0, TAU);
    ctx.fill();
  }
  ctx.restore();
}
