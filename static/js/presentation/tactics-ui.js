import { abilityReason, SIGNAL_NAMES } from './tactics.js';

const $ = id => document.getElementById(id);

/** 战术操作、观战与辅助设置独立于规则；所有标点仍需服务器确认。 */
export class TacticsUI {
  constructor({ getSession, canvas, camera, renderer, toast }) {
    Object.assign(this, { getSession, canvas, camera, renderer, toast });
    this.pingKind = null; this.roundId = ''; this.seen = new Set(); this.lastSkillNote = -Infinity;
    this.spectatorSignature = ''; this.lastMetricAt = 0;
    for (const [id, key, fallback] of [['split-preview', 'orbit.splitPreview', false], ['performance-toggle', 'orbit.performance', false]]) {
      try { $(id).checked = localStorage.getItem(key) === 'on'; } catch { $(id).checked = fallback; }
      $(id).addEventListener('change', () => {
        try { localStorage.setItem(key, $(id).checked ? 'on' : 'off'); } catch { /* 本次设置仍生效。 */ }
        if (id === 'split-preview') renderer.previewEnabled = $(id).checked;
      });
    }
    renderer.previewEnabled = $('split-preview').checked;
    for (const kind of Object.keys(SIGNAL_NAMES)) $(`signal-${kind}`).addEventListener('click', () => this.arm(kind));
    $('signal-cancel').addEventListener('click', () => this.cancel());
    const selectSpectator = (value, offset = null) => {
      this.getSession()?.selectSpectator?.(value, offset);
      this.canvas.focus({ preventScroll: true });
    };
    $('spectator-select').addEventListener('change', event => selectSpectator(event.target.value));
    $('spectator-prev').addEventListener('click', () => selectSpectator('', -1));
    $('spectator-next').addEventListener('click', () => selectSpectator('', 1));
    window.addEventListener('blur', () => this.cancel());
  }
  arm(kind) {
    const snapshot = this.getSession().getSnapshot();
    if (!snapshot.team || snapshot.state !== 'playing' || snapshot.spectating) return;
    if (snapshot.pingCooldown > 0) { this.toast('标点冷却中，间隔两秒'); return; }
    this.pingKind = this.pingKind === kind ? null : kind;
    this.canvas.classList.toggle('signal-aiming', Boolean(this.pingKind));
    this.canvas.focus({ preventScroll: true });
    this.render(snapshot);
  }
  cancel() {
    const had = Boolean(this.pingKind); this.pingKind = null;
    this.canvas.classList.remove('signal-aiming');
    return had;
  }
  point(event, snapshot) {
    const rect = this.canvas.getBoundingClientRect();
    const x = (event.clientX - rect.left) * this.renderer.width / rect.width;
    const y = (event.clientY - rect.top) * this.renderer.height / rect.height;
    const map = this.renderer.getMiniMapBounds(snapshot);
    if (x >= map.x && x <= map.x + map.width && y >= map.y && y <= map.y + map.height)
      return { x: (x - map.x) / map.sx, y: (y - map.y) / map.sy };
    const view = this.camera.getView();
    return { x: view.left + x / this.renderer.width * (view.right - view.left),
      y: view.top + y / this.renderer.height * (view.bottom - view.top) };
  }
  pointer(event) {
    if (event.button !== 0) return false;
    const session = this.getSession(), snapshot = session.getSnapshot();
    if (this.pingKind) {
      if (snapshot.team && snapshot.state === 'playing' && !snapshot.spectating && session.ping(this.pingKind, this.point(event, snapshot)))
        this.toast(`${SIGNAL_NAMES[this.pingKind]} · 已发送给队友`);
      this.cancel();
      return true; // 这一次左键用于标点，不会同时吐孢子。
    }
    if (snapshot.spectating && snapshot.state === 'playing' && snapshot.spectator?.mode === 'free') {
      session.spectator.locate(this.point(event, snapshot), snapshot.bounds);
      return true;
    }
    return false;
  }
  skillAttempt(kind) {
    const reason = abilityReason(this.getSession().getSnapshot(), kind);
    const now = performance.now();
    if (reason && now - this.lastSkillNote > 700) {
      this.lastSkillNote = now;
      this.toast(`${kind === 'split' ? '分裂' : '吐孢子'}：${reason}`);
    }
  }
  render(snapshot) {
    const round = snapshot.network?.room?.roundId ?? '';
    if (round !== this.roundId) { this.roundId = round; this.seen.clear(); this.cancel(); }
    const teamActive = Boolean(snapshot.team && snapshot.state === 'playing' && !snapshot.spectating);
    $('signals-hud').hidden = !teamActive;
    if (!teamActive) this.cancel();
    for (const kind of Object.keys(SIGNAL_NAMES)) {
      $(`signal-${kind}`).disabled = !teamActive || snapshot.pingCooldown > 0;
      $(`signal-${kind}`).setAttribute('aria-pressed', String(this.pingKind === kind));
    }
    $('signal-cancel').hidden = !this.pingKind;
    $('signal-status').textContent = this.pingKind ? `${SIGNAL_NAMES[this.pingKind]}：点击画面或小地图，Esc 取消` :
      snapshot.pingCooldown > 0 ? `标点冷却 ${snapshot.pingCooldown.toFixed(1)}s` : '按 1 / 2 / 3 选标点，再点击位置';
    for (const ping of snapshot.pings || []) {
      if (!this.seen.has(ping.id) && ping.ownerId !== snapshot.network?.playerId) this.toast(`${ping.name}：${SIGNAL_NAMES[ping.kind]}`);
      this.seen.add(ping.id);
    }
    // 消息集合按现存标点收缩；长局不会无限累计历史编号。
    this.seen = new Set((snapshot.pings || []).map(ping => ping.id));

    const observing = Boolean(snapshot.spectating && snapshot.state === 'playing');
    $('spectator-hud').hidden = !observing;
    if (observing) {
      const spectator = snapshot.spectator;
      const signature = JSON.stringify(spectator.choices.map(entry => [entry.ownerId, entry.name, entry.ally]));
      if (signature !== this.spectatorSignature) {
        this.spectatorSignature = signature;
        const free = document.createElement('option'); free.value = 'free'; free.textContent = '自由镜头';
        $('spectator-select').replaceChildren(free, ...spectator.choices.map(entry => {
          const option = document.createElement('option'); option.value = entry.ownerId;
          option.textContent = `#${entry.rank} ${entry.ally ? '队友 · ' : ''}${entry.name}`; return option;
        }));
      }
      $('spectator-select').value = spectator.mode === 'free' ? 'free' : spectator.ownerId;
      const target = spectator.choices.find(entry => entry.ownerId === spectator.ownerId);
      $('spectator-info').textContent = spectator.mode === 'free' ? 'WASD / 摇杆移动 · 点击画面或小地图定位' :
        target ? `${target.lives} 条命 · ${Math.round(target.mass)} m · #${target.rank}` : '等待存活玩家';
    }
    const zone = snapshot.safeZone;
    $('zone-hud').hidden = !zone || snapshot.state === 'ready';
    if (zone) {
      $('zone-hud').dataset.phase = zone.exposure > 0 ? 'outside' : zone.phase;
      const phase = { waiting: `${Math.ceil(zone.remaining)}s 后缩圈`, warning: `${Math.ceil(zone.remaining)}s 后缩圈 · 看黄色虚线`,
        shrinking: `正在缩圈 · ${Math.ceil(zone.remaining)}s`, final: '最终安全区' }[zone.phase];
      $('zone-status').textContent = `缩圈乱斗 · ${phase}`;
      $('zone-penalty').textContent = snapshot.spectating ? '观战中' : zone.exposure > 0 ?
        `全体分身在圈外 · ${Math.max(0, zone.exposureLimit - zone.exposure).toFixed(1)}s 后扣命` : '圈外分身掉质量 · 全部在圈外连续 8s 扣 1 命';
    }
    for (const kind of ['split', 'spore']) {
      const reason = abilityReason(snapshot, kind);
      $(`${kind}-hint`).textContent = reason || (kind === 'split' ? '右键 / Q · 分裂不扣分' : '长按连吐 · 喂刺 5 颗反击');
    }
    const showMetrics = $('performance-toggle').checked;
    $('performance-status').hidden = !showMetrics;
    const now = performance.now();
    if (showMetrics && now - this.lastMetricAt > 500) {
      this.lastMetricAt = now;
      const metrics = this.renderer.metrics.snapshot();
      $('performance-status').textContent = metrics ? `${Math.round(metrics.fps)} FPS · Canvas P95 ${metrics.drawP95.toFixed(1)} ms` : '开始游戏后采样性能';
    }
    const extraHeight = [...document.querySelectorAll('.tactical-hud, .assist-settings, .team-bot-status')]
      .reduce((total, node) => total + (node.hidden ? 0 : node.offsetHeight), 0);
    const panel = this.canvas.closest('.arena-panel');
    const value = `${extraHeight}px`;
    if (panel.style.getPropertyValue('--tactical-height') !== value) panel.style.setProperty('--tactical-height', value);
  }
}
