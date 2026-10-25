const $ = id => document.getElementById(id);

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
      void this.getSession()?.enter(type, name, $("room-code-input").value);
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
    $("leave-room").addEventListener("click", () => this.getSession()?.leave());
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
    $("network-quality").textContent = rtt === null ? qualityText : `${qualityText} · ${rtt} ms`;
    $("network-quality").dataset.quality = quality || "unknown";
    $("network-connect").hidden = Boolean(room);
    $("network-lobby").hidden = !room;
    $("leave-room").hidden = !room;
    const aiCount = room?.aiCount ?? Math.max(0, (room?.capacity ?? 4) - (room?.members.length ?? 0));
    $("network-hint").textContent = connection === "connecting" ? "正在连接服务器…" : connection === "reconnecting" ? "连接中断 · 正在恢复本局…" : !room ? "局域网联机 · 真人不足时自动补人机 · 每局 5 分钟" :
      `房间 ${room.code} · 真人 ${room.members.length}/${room.capacity ?? 4} · 人机 ${aiCount}${snapshot.spectating ? " · 已出局，观战中" : network.inactive && snapshot.state === "playing" ? " · 已停止操作，对局继续" : ""}${rtt === null ? "" : ` · ${rtt} ms`}`;
    $("create-room").disabled = $("join-room").disabled = ["connecting", "reconnecting"].includes(connection);
    if (!room) { this.signature = ""; return; }
    $("room-number").textContent = room.code;
    $("room-ready").hidden = room.state !== "waiting";
    $("room-ready").textContent = me?.ready ? "取消准备" : "准备";
    $("room-ready").setAttribute("aria-pressed", String(Boolean(me?.ready)));
    $("room-start").hidden = !host || room.state !== "waiting";
    $("room-start").disabled = !room.members.length || !room.members.every(member => member.ready);
    $("room-rematch").hidden = !host || room.state !== "finished";
    const readyCount = room.members.filter(member => member.ready).length;
    $("room-progress").textContent = room.state === "waiting" ? `${readyCount} / ${room.members.length} 位真人已准备 · 空位自动补人机` : room.state === "finished" ? "本局已结束" : `本局进行中 · 人机 ${aiCount}`;
    $("room-waiting").textContent = room.state === "finished" ? (host ? "点击“返回准备室”，所有人重新准备即可再来一局。" : "等待房主返回准备室，再准备下一局。") :
      !room.members.every(member => member.ready) ? `还差 ${room.members.length - readyCount} 位真人准备，房主准备后即可开始。` : "所有真人已准备，房主可以开始；空位会自动补足为人机。";
    const signature = JSON.stringify({ room, playerId });
    if (signature === this.signature) return;
    this.signature = signature;
    $("room-copy-status").textContent = "";
    const url = new URL(this.inviteOrigin);
    url.search = new URLSearchParams({ room: room.code }).toString();
    $("room-invite").value = url.href;
    $("room-members").replaceChildren(...room.members.map(member => {
      const row = document.createElement("li"), name = document.createElement("span"), status = document.createElement("strong");
      name.textContent = `${member.name}${member.id === playerId ? "（你）" : ""}${member.id === room.hostId ? " · 房主" : ""}`;
      status.textContent = !member.connected ? "重连中" : room.state !== "waiting" ? "本局成员" : member.ready ? "已准备" : "待准备";
      row.dataset.ready = String(member.ready); row.dataset.connected = String(member.connected !== false); row.append(name, status); return row;
    }));
  }
}
