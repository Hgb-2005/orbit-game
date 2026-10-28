/** 复盘只读取采样，不重新模拟。SVG 随容器缩放，深浅主题共用配色变量。 */
export const recapTime = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

export function chartGeometry(points = []) {
  const valid = points.filter(p => Array.isArray(p) && p.length === 2 && p.every(Number.isFinite));
  const duration = Math.max(1, ...valid.map(p => p[0]));
  const peak = Math.max(36, ...valid.map(p => p[1]));
  return { duration, peak, path: valid.map((p, i) => `${i ? 'L' : 'M'}${(12 + p[0] / duration * 296).toFixed(2)},${(98 - p[1] / peak * 74).toFixed(2)}`).join(' ') };
}

export function telemetryView(stats = {}) {
  const root = document.createElement('div'); root.className = 'telemetry-view';
  const title = document.createElement('p'); title.textContent = '总质量变化'; root.append(title);
  const points = stats.massTimeline ?? [];
  if (points.length) {
    const { path, peak, duration } = chartGeometry(points);
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 320 122'); svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `总质量曲线，${recapTime(duration)}，采样峰值 ${Math.round(peak)} m`);
    const line = document.createElementNS(ns, 'path'); line.setAttribute('d', 'M12,24H308 M12,61H308 M12,98H308'); line.setAttribute('class', 'chart-grid'); svg.append(line);
    const curve = document.createElementNS(ns, 'path'); curve.setAttribute('d', path); curve.setAttribute('class', 'chart-curve'); svg.append(curve);
    for (const [x, y, text, anchor] of [[12, 14, `${Math.round(peak)} m`, 'start'], [12, 116, '0:00', 'start'], [308, 116, recapTime(duration), 'end']]) {
      const label = document.createElementNS(ns, 'text'); label.setAttribute('x', x); label.setAttribute('y', y); label.setAttribute('text-anchor', anchor); label.textContent = text; svg.append(label);
    }
    root.append(svg);
  } else {
    const empty = document.createElement('p'); empty.className = 'recap-note'; empty.textContent = '本局暂无质量采样'; root.append(empty);
  }
  const deaths = stats.deathLog ?? [];
  const heading = document.createElement('p'); heading.textContent = '生命损失记录'; root.append(heading);
  const list = document.createElement('ol'); list.className = 'death-log';
  for (const death of deaths) {
    const row = document.createElement('li');
    const cause = death.cause === 'zone' ? '圈外停留过久' : death.cause === 'departed' ? '离线超时或主动退出' : `被「${death.killer}」吞噬末球`;
    row.textContent = `${recapTime(death.time)} · ${cause}${death.mass > 0 ? ` · ${Math.round(death.mass)} m` : ''}`;
    list.append(row);
  }
  if (!deaths.length) { const empty = document.createElement('li'); empty.textContent = Array.isArray(stats.deathLog) ? '本局没有生命损失' : '本局暂无生命事件记录'; list.append(empty); }
  root.append(list);
  const note = document.createElement('p'); note.className = 'recap-note';
  note.textContent = '曲线为定期采样，损失生命与复活时补点；长局自动精简。生命事件最多显示最近 40 条。'; root.append(note);
  return root;
}
