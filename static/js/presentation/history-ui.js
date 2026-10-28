import { telemetryView, recapTime } from './match-recap.js';
import { recapItems } from './recap.js';

export const MODE_NAMES = { classic: '单机经典', survival: '单机生存', 'network-survival': '联机生存', teams: '2v2 团队', shrink: '缩圈乱斗' };
const $ = id => document.getElementById(id);
const node = (tag, text, className = '') => { const el = document.createElement(tag); el.textContent = text; el.className = className; return el; };

export function historySummary(matches, mode = 'all') {
  const selected = matches.filter(m => mode === 'all' || m.mode === mode);
  const players = selected.flatMap(m => m.participants);
  return { rounds: selected.length, peak: Math.max(0, ...players.map(p => p.stats.peakMass ?? 0)),
    eaten: players.reduce((s, p) => s + (p.stats.cellsEaten ?? 0), 0) };
}

/** 原生模态框支持 Esc 与焦点约束；昵称与文本均通过 textContent 显示。 */
export class HistoryUI {
  constructor(service, { onOpen = () => {}, onClose = () => {} } = {}) {
    this.service = service; this.selected = ''; this.playerIndex = 0;
    $('history-open').addEventListener('click', () => { onOpen(); $('history-dialog').showModal(); this.render(); void service.load(); });
    $('history-close').addEventListener('click', () => $('history-dialog').close());
    $('history-dialog').addEventListener('close', onClose);
    $('history-refresh').addEventListener('click', () => { void service.load(); void service.flush(); });
    $('history-filter').addEventListener('change', () => { this.selected = ''; this.render(); });
    $('history-player').addEventListener('change', event => { this.playerIndex = Number(event.target.value); this.renderDetail(); });
  }
  render() {
    const service = this.service, mode = $('history-filter').value;
    $('history-status').textContent = service.status === 'offline' ? `暂时无法连接，已保存的记录仍可查看${service.pending.length ? `；${service.pending.length} 局等待重试` : ''}` : service.status === 'loading' ? '正在读取记录…' : '本机服务共享最近 20 局 · 联机由服务器结算 · 练习与未完成单机局不记入';
    const matches = service.matches.filter(m => mode === 'all' || m.mode === mode);
    const summary = historySummary(service.matches, mode);
    $('history-summary').textContent = `最近 ${summary.rounds} 局 · 真人吞噬 ${summary.eaten} 球 · 最高质量 ${Math.round(summary.peak)} m`;
    if (!matches.some(m => m.id === this.selected)) { this.selected = matches[0]?.id ?? ''; this.playerIndex = 0; }
    $('history-list').replaceChildren(...matches.map(match => {
      const row = node('button', '', 'history-row'); row.type = 'button'; row.setAttribute('aria-pressed', String(match.id === this.selected));
      const date = new Date(match.createdAt);
      const time = Number.isNaN(date.getTime()) ? '' : date.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
      row.append(node('strong', `${MODE_NAMES[match.mode] ?? match.mode} · ${recapTime(match.duration)}`),
        node('span', match.participants.map(p => `${p.name}${p.rank ? ` #${p.rank}` : ''}`).join(' / ')),
        node('small', `${time} · ${match.source === 'server' ? '服务器结算' : '单机记录'}${match.reason === 'abandoned' ? ' · 中途退出' : ''}`));
      row.addEventListener('click', () => { this.selected = match.id; this.playerIndex = 0; this.render(); });
      return row;
    }));
    $('history-empty').hidden = matches.length > 0;
    $('history-detail').hidden = !this.selected;
    const match = matches.find(m => m.id === this.selected);
    if (match) {
      $('history-player').replaceChildren(...match.participants.map((p, i) => { const option = node('option', p.name); option.value = String(i); return option; }));
      this.playerIndex = Math.min(this.playerIndex, match.participants.length - 1);
      $('history-player').value = String(this.playerIndex); this.renderDetail();
    }
  }
  renderDetail() {
    const match = this.service.matches.find(m => m.id === this.selected), player = match?.participants[this.playerIndex];
    if (!player) return;
    const outcome = match.reason === 'abandoned' ? '中途退出' : match.mode === 'classic' ? '本局结束' : player.won ? '获胜' : '未获胜';
    $('history-result').textContent = `${outcome} · ${player.rank ? `第 ${player.rank} 名 · ` : ''}击败 ${player.kills} 次 · 得分 ${player.score}`;
    $('history-stats').replaceChildren(...recapItems({ stats: player.stats }).map(item => { const row = document.createElement('div'); row.append(node('dt', item.label), node('dd', item.value)); return row; }));
    $('history-telemetry').replaceChildren(telemetryView(player.stats));
  }
}
