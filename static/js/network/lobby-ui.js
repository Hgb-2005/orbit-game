const $ = id => document.getElementById(id);
import { ROOM_DEFAULTS, ROOM_PRESETS, RULE_FIELDS, MODE_NAMES, describeRules, presetName } from "./room-rules.js";

/** 房间显示与模拟分开；昵称一律用 textContent，不解释为 HTML。 */
export class LobbyUI {
  constructor(getSession) {
    this.getSession = getSession;
    this.signature = "";
    this.inviteOrigin = location.origin;
    void fetch("/api/network-info").then(response => response.json()).then(info => {
      if (info.urls?.length) {
        if (["localhost", "127.0.0.1", "[::1]"].includes(location.hostname)) this.inviteOrigin = new URL(info.urls[0]).origin;
        $("lan-address").textContent = `朋友连接同一 Wi-Fi，访问 ${this.inviteOrigin}/ 后选择联机。服务器需用 start-lan.bat 启动。`;
        this.signature = "";
      }
    }).catch(() => { /* 手动输入局域网地址仍可联机。 */ });
    const invitation = new URLSearchParams(location.search).get("room");
    if (invitation && /^\d{6}$/.test(invitation)) $("room-code-input").value = invitation;
    try { $("nickname").value = localStorage.getItem("orbit.nickname") || ""; } catch { /* 昵称仍可输入。 */ }
    const enter = type => {
      const name = $("nickname").value.trim();
      if (!name || name.length > 12) { $("network-error").textContent = "请输入 1～12 个字的昵称。"; $("nickname").focus(); return; }
      try { localStorage.setItem("orbit.nickname", name); } catch { /* 无需存储也能联机。 */ }
      void this.getSession()?.enter(type, name, $("room-code-input").value,
        this.readRules("new-room"));
    };
    $("create-room").addEventListener("click", () => enter("create"));
    $("join-room").addEventListener("click", () => enter("join"));
    $("room-code-input").addEventListener("keydown", event => { if (event.key === "Enter") enter("join"); });
    $("room-code-input").addEventListener("input", event => {
      event.target.value = event.target.value.replace(/\D/g, "").slice(0, 6);
    });
    $("room-ready").addEventListener("click", () => {
      const session = this.getSession();
      const me = session?.room?.members.find(member => member.id === session.playerId);
      if (me) session.ready(!me.ready);
    });
    $("room-start").addEventListener("click", () => this.getSession()?.start());
    $("room-rematch").addEventListener("click", () => this.getSession()?.rematch());
    for (const team of [0, 1]) $(`room-team-${team}`).addEventListener('click', () => this.getSession()?.chooseTeam(team));
    $("leave-room").addEventListener("click", () => this.getSession()?.leave());
    for (const prefix of ["new-room", "room"]) {
      const changed = event => {
        if (event?.target.id === `${prefix}-mode` && event.target.value === 'shrink') $(`${prefix}-duration`).value = '180';
        if ($(`${prefix}-mode`).value === "teams") $(`${prefix}-bot-count`).value = "-1";
        const rules = this.readRules(prefix);
        $(`${prefix}-preset`).value = presetName(rules);
        if (prefix === "room") this.getSession()?.configure(rules);
        else {
          $("new-room-note").textContent = describeRules(rules);
          $("new-room-bot-count").disabled = rules.mode === "teams";
        }
      };
      for (const field of Object.values(RULE_FIELDS)) $(`${prefix}-${field}`).addEventListener("change", changed);
      $(`${prefix}-preset`).addEventListener("change", event => {
        const preset = ROOM_PRESETS[event.target.value];
        if (!preset) return;
        this.writeRules(prefix, { ...this.readRules(prefix), ...preset }); changed();
      });
    }
    $("new-room-note").textContent = describeRules(ROOM_DEFAULTS);
    $("copy-room-link").addEventListener("click", async () => {
      const url = new URL(this.inviteOrigin);
      url.search = new URLSearchParams({ room: this.getSession().room.code }).toString();
      try { await navigator.clipboard.writeText(url.href); $("room-copy-status").textContent = "邀请链接已复制"; }
      catch {
        // 局域网 HTTP 可能没有剪贴板权限，提供可选中的文本作为兜底。
        $("room-copy-status").textContent = "请选中下方链接复制";
        $("room-invite").focus(); $("room-invite").select();
      }
    });
  }

  render(snapshot) {
    const network = snapshot.network;
    $("network-hud").hidden = !network;
    $("multiplayer-panel").hidden = !network || snapshot.state === "playing";
    if (!network) return;
    const { room, playerId, connection, error, rtt, quality } = network;
    const me = room?.members.find(member => member.id === playerId);
    const host = room?.hostId === playerId;
    $("network-error").textContent = error;
    const qualityText = { good: "连接良好", fair: "连接一般", poor: "延迟较高", unknown: "等待同步", offline: "未连接", reconnecting: "正在重连" }[quality] || "等待同步";
    $("network-quality").textContent = rtt === null ? qualityText : `${qualityText} · ${rtt} ms${snapshot.state === "playing" ? ` · ${network.downloadKBps.toFixed(1)} KB/s` : ""}`;
    $("network-quality").title = `网络波动 ${network.jitter} ms · 对手插值缓冲 ${network.interpolationDelay} ms${network.predictionActive ? ` · 本机移动预测 ${network.predictionMs} ms` : ''}`;
    $("network-quality").dataset.quality = quality || "unknown";
    $("network-connect").hidden = Boolean(room);
    $("network-lobby").hidden = !room;
    $("network-lobby").dataset.state = room?.state || "waiting";
    $("leave-room").hidden = !room;
    const aiCount = room?.aiCount ?? Math.max(0, (room?.capacity ?? 4) - (room?.members.length ?? 0));
    const ruleLabel = MODE_NAMES[room?.rules?.mode] ?? '生存乱斗';
    $("network-hint").textContent = connection === "connecting" ? "正在连接服务器…" : connection === "reconnecting" ? "连接中断 · 正在恢复本局…" : !room ? "局域网联机 · 生存乱斗 / 缩圈乱斗 / 2v2 团队" :
      `房间 ${room.code} · ${ruleLabel}${room.ranked === false ? " · 自定义局" : ""} · 真人 ${room.members.length}/${room.capacity ?? 4} · 人机 ${aiCount}${snapshot.state === "gameover" ? " · 本局已结束" : snapshot.spectating ? " · 已出局，观战中" : network.inactive && snapshot.state === "playing" ? " · 已停止操作，对局继续" : ""}`;
    $("create-room").disabled = $("join-room").disabled = ["connecting", "reconnecting"].includes(connection);
    if (!room) { this.signature = ""; return; }
    $("room-number").textContent = room.code;
    $("room-ready").hidden = room.state !== "waiting";
    $("room-ready").textContent = me?.ready ? "取消准备" : "准备";
    $("room-ready").setAttribute("aria-pressed", String(Boolean(me?.ready)));
    $("room-start").hidden = !host || room.state !== "waiting";
    const allReady = room.members.length > 0 && room.members.every(member => member.ready && member.connected !== false);
    const enoughPlayers = (room.participantCount ?? room.members.length + aiCount) >= 2;
    $("room-start").disabled = !allReady || !enoughPlayers;
    const locked = !host || room.state !== "waiting" || connection !== "connected";
    this.writeRules("room", room.rules);
    for (const field of [...Object.values(RULE_FIELDS), "preset"]) $(`room-${field}`).disabled = locked;
    $("room-bot-count").disabled ||= room.rules?.mode === "teams";
    const teamMode = room.rules?.mode === 'teams';
    $('room-teams').hidden = !teamMode || room.state !== 'waiting';
    if (teamMode) {
      const names = ['薄荷队', '星云队'];
      $('room-team-status').textContent = `你的队伍：${names[me?.team] ?? '等待分配'} · 2v2`;
      for (const team of [0, 1]) {
        const button = $(`room-team-${team}`);
        const humans = room.members.filter(member => member.team === team);
        const own = me?.team === team;
        button.textContent = `${names[team]}${own ? ' · 已加入' : humans.length >= 2 ? ' · 已满' : ' · 加入'}\n真人 ${humans.length}/2 · 人机补位 ${Math.max(0, 2 - humans.length)}\n${humans.map(member => member.name).join('、') || '等待加入'}`;
        button.setAttribute('aria-pressed', String(own));
        button.disabled = own || humans.length >= 2 || room.state !== 'waiting' || connection !== 'connected';
      }
    }
    $("room-rules-note").textContent = `${describeRules(room.rules, room.members.length)}${room.rules?.mode === "teams" ? "队友不能互吃，可吐孢子喂养，按团队合计排名。" : "每人 3 命，按命数、击败和质量排名。"}${host ? " 修改规则后全员需重新准备。" : " 规则由房主设置。"}`;
    $("room-rematch").hidden = !host || room.state !== "finished";
    const readyCount = room.members.filter(member => member.ready).length;
    $("room-progress").textContent = room.state === "waiting" ? `${readyCount} / ${room.members.length} 位真人已准备 · 本局人机 ${aiCount} 名` : room.state === "finished" ? "本局已结束" : `本局进行中 · 人机 ${aiCount}`;
    $("room-waiting").textContent = room.state === "finished" ? (host ? "点击“返回准备室”，所有人重新准备即可再来一局。" : "等待房主返回准备室，再准备下一局。") :
      room.members.some(member => member.connected === false) ? "有成员正在重连，恢复连接后才能开始。" :
      !enoughPlayers ? "至少需要两位参赛者，请邀请朋友或增加人机。" :
      !allReady ? `还差 ${room.members.length - readyCount} 位真人准备，全员准备后房主即可开始。` : `所有真人已准备，房主可以开始；本局安排 ${aiCount} 名人机。`;
    const signature = JSON.stringify({ room, playerId });
    if (signature === this.signature) return;
    this.signature = signature;
    $("room-copy-status").textContent = "";
    const url = new URL(this.inviteOrigin);
    url.search = new URLSearchParams({ room: room.code }).toString();
    $("room-invite").value = url.href;
    $("room-members").replaceChildren(...room.members.map(member => {
      const row = document.createElement("li"), name = document.createElement("span"), status = document.createElement("strong");
      const team = member.team == null ? "" : member.team === 0 ? " · 薄荷队" : " · 星云队";
      name.textContent = `${member.name}${member.id === playerId ? "（你）" : ""}${member.id === room.hostId ? " · 房主" : ""}${team}`;
      if (member.team != null) name.style.color = member.team === 0 ? "#93d9bc" : "#b5a3e8";
      status.textContent = !member.connected ? "重连中" : room.state !== "waiting" ? "本局成员" : member.ready ? "已准备" : "待准备";
      row.dataset.ready = String(member.ready); row.dataset.connected = String(member.connected !== false); row.append(name, status); return row;
    }));
  }

  readRules(prefix) {
    return Object.fromEntries(Object.entries(RULE_FIELDS).map(([key, field]) => {
      const value = $(`${prefix}-${field}`).value;
      return [key, ["duration", "botCount", "initialMass"].includes(key) ? Number(value) : value];
    }));
  }

  writeRules(prefix, rules) {
    const value = { ...ROOM_DEFAULTS, ...rules };
    for (const [key, field] of Object.entries(RULE_FIELDS)) $(`${prefix}-${field}`).value = String(value[key]);
    $(`${prefix}-preset`).value = presetName(value);
  }
}
