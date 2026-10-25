import { CONFIG } from "./config.js";

export function formatTime(seconds) {
  const total = Math.floor(seconds);
  return `${Math.floor(total / 60).toString().padStart(2, "0")}:${(total % 60).toString().padStart(2, "0")}`;
}

const number = value => Math.round(value).toLocaleString("zh-CN");
const $ = id => document.getElementById(id);

/** DOM 显示与 Canvas 绘制分开，更新 HUD 不会触碰游戏规则。 */
export class GameUI {
  constructor() {
    this.lastState = "";
    this.isNewRecord = false;
    this.toastTimer = null;
    this.theme = "dark";
    this.focusPreference = null;
    this.focusMode = false;
    this.onFocusChange = () => {};
    this.lastLeaderboard = "";
    this.feedbackPhase = "normal";
    this.mode = "classic";
    this.onModeChange = () => {};
    this.labelObstacles = [...document.querySelectorAll(".arena-corner, .canvas-stage, .hotspot-status, #leaderboard, #protection-hint, #ability-panel, #milestone-banner")];
    $("leaderboard").open = !window.matchMedia("(max-width: 760px)").matches;
    try {
      this.theme = localStorage.getItem("orbit.theme") === "light" ? "light" : "dark";
      const focus = localStorage.getItem("orbit.focus");
      if (focus === "on" || focus === "off") this.focusPreference = focus === "on";
      if (localStorage.getItem("orbit.mode") === "survival") this.mode = "survival";
    } catch { /* 无存储权限时使用默认主题。 */ }
    this.applyTheme();
    $("game-mode").value = this.mode;
    this.setFocus(this.focusPreference === true);
  }

  bind({ start, pause, restart, theme, focus, split, spore, music, volume, effects }) {
    $("game-mode").addEventListener("change", event => {
      this.mode = ["survival", "multiplayer"].includes(event.target.value) ? event.target.value : "classic";
      if (this.mode !== "multiplayer") {
        try { localStorage.setItem("orbit.mode", this.mode); } catch { /* 本局设置仍然有效。 */ }
      }
      this.onModeChange(this.mode);
      if (this.lastSnapshot) this.renderOverlay(this.lastSnapshot);
    });
    $("start-button").addEventListener("click", () => { start(); $("start-button").blur(); });
    $("pause-button").addEventListener("click", () => { pause(); $("pause-button").blur(); });
    $("restart-button").addEventListener("click", () => { restart(); $("restart-button").blur(); });
    $("focus-button").addEventListener("click", focus);
    $("split-button").addEventListener("click", split);
    $("spore-button").addEventListener("click", spore);
    $("music-toggle").addEventListener("click", music);
    $("effects-toggle").addEventListener("click", effects);
    $("music-volume").addEventListener("input", event => volume(Number(event.target.value) / 100));
    $("theme-toggle").addEventListener("click", () => {
      this.theme = this.theme === "dark" ? "light" : "dark";
      this.applyTheme();
      theme(this.theme);
    });
  }

  setFocus(enabled, remember = false) {
    this.focusMode = enabled;
    document.body.classList.toggle("focus-mode", enabled);
    $("focus-button").setAttribute("aria-pressed", String(enabled));
    $("focus-label").textContent = enabled ? "退出专注" : "专注模式";
    if (remember) {
      this.focusPreference = enabled;
      try { localStorage.setItem("orbit.focus", enabled ? "on" : "off"); } catch { /* 本次选择仍有效。 */ }
    }
    this.onFocusChange();
  }

  focusOnStart() {
    if (this.focusPreference !== false) this.setFocus(true);
  }

  handleEvents(events) {
    for (const event of events) {
      if (event.type === "merge") this.toast("分身已合体，总质量保留");
      if (event.type === "celllost") this.toast("一个分身被吞噬，控制剩余分身继续生长");
      if (event.type === "hotspots") this.toast("微光富集区已换位，查看小地图里的金圈");
      if (event.type === "departed") this.toast(`「${event.name}」已退出，本局按出局处理`);
      if (event.type === "eliminated" && event.isPlayer) this.toast("命数归零，进入观战；对局结束后可准备下一局");
      if (event.type === "life" && event.isPlayer) this.toast(`击败「${event.victim}」 · +1 命，现有 ${event.lives} 条命`);
      if (event.type === "respawn" && event.isPlayer) {
        this.toast(`已复活 · 剩余 ${event.lives} 条命 · 质量恢复 36 m · 保护 3 秒`);
        $("feedback-announcement").textContent = `已复活，剩余 ${event.lives} 条命，保护 3 秒`;
      }
      if (event.type === "milestone") {
        clearTimeout(this.milestoneTimer);
        $("milestone-banner").textContent = `✧ 达成 ${number(event.reached)} 分 · 进入「${event.stage.title}」`;
        $("milestone-banner").hidden = false;
        this.milestoneTimer = setTimeout(() => { $("milestone-banner").hidden = true; }, 3500);
      }
    }
  }

  resetRound() {
    clearTimeout(this.milestoneTimer);
    clearTimeout(this.toastTimer);
    $("toast").hidden = true;
    $("milestone-banner").hidden = true;
    for (const ability of ["split", "spore"]) $(`${ability}-button`).classList.remove("ready-cue");
    $("feedback-announcement").textContent = "";
    this.feedbackPhase = "normal";
  }

  /** 主装配层把 HUD 几何传给绘制层，标签布局无需依赖 DOM 或查询页面元素。 */
  getLabelObstacles(canvasRect) {
    return this.labelObstacles.map(element => element.getBoundingClientRect()).filter(rect => rect.width > 0 && rect.height > 0)
      .map(rect => ({ left: rect.left - canvasRect.left, right: rect.right - canvasRect.left,
        top: rect.top - canvasRect.top, bottom: rect.bottom - canvasRect.top }));
  }

  renderFeedback(snapshot, feedback) {
    $("ability-panel").dataset.paused = String(snapshot.state !== "playing");
    const announcements = [];
    for (const ability of ["split", "spore"]) {
      const button = $(`${ability}-button`);
      const active = Boolean(feedback.skills[ability]);
      if (active && !button.classList.contains("ready-cue") && snapshot.state === "playing") {
        announcements.push(ability === "spore" ? "吐孢子已就绪" : "分裂已就绪");
      }
      button.classList.toggle("ready-cue", active);
    }
    const phase = feedback.hotspots.phase;
    $("hotspot-status").parentElement.dataset.phase = phase;
    if (phase === "warning" && this.feedbackPhase !== phase && snapshot.state === "playing") {
      announcements.push(`富集区将在 ${Math.ceil(snapshot.hotspots.remaining)} 秒后换位`);
    }
    this.feedbackPhase = phase;
    if (announcements.length) $("feedback-announcement").replaceChildren(document.createTextNode(announcements.join("；")));
  }

  applyTheme() {
    document.documentElement.dataset.theme = this.theme;
    $("theme-label").textContent = this.theme === "dark" ? "深色模式" : "浅色模式";
    $("theme-toggle").setAttribute("aria-label", this.theme === "dark" ? "切换至浅色模式" : "切换至深色模式");
    document.querySelector('meta[name="theme-color"]').content = this.theme === "dark" ? "#101615" : "#f2f5f1";
    try { localStorage.setItem("orbit.theme", this.theme); } catch { /* 主题照常切换。 */ }
  }

  renderMusic({ supported, enabled, volume, playing, blocked }) {
    const button = $("music-toggle");
    const percent = Math.round(volume * 100);
    button.disabled = !supported;
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("aria-label", supported ? `${enabled ? "关闭" : "开启"}背景音乐` : "当前浏览器不支持背景音乐");
    button.title = !supported ? "当前浏览器不支持背景音乐" : playing ? "正在播放轻柔背景音乐，点击关闭" :
      blocked ? "点击音乐开关或继续游戏以播放音乐" : !enabled ? "点击开启背景音乐" :
      volume === 0 ? "音量为 0，将旁边的音量滑块调高即可恢复" : "音乐已开启，开始或继续游戏时播放";
    $("music-label").textContent = !supported ? "音乐不可用" : enabled ? "音乐开启" : "音乐关闭";
    $("music-controls").dataset.muted = String(!enabled || volume === 0);
    $("music-controls").dataset.playing = String(playing);
    $("music-volume").disabled = !supported;
    // 不重复写入正在拖动的滑块，避免浏览器拖拽过程中丢失指针位置。
    if (Number($("music-volume").value) !== percent) $("music-volume").value = String(percent);
    $("music-volume").setAttribute("aria-valuetext", `${percent}%`);
    $("music-volume-value").textContent = `${percent}%`;
  }

  renderEffects({ supported, enabled }) {
    const button = $("effects-toggle");
    button.disabled = !supported;
    button.setAttribute("aria-pressed", String(enabled));
    button.setAttribute("aria-label", supported ? `${enabled ? "关闭" : "开启"}游戏音效` : "当前浏览器不支持游戏音效");
    button.title = !supported ? "当前浏览器不支持游戏音效" : enabled ? "游戏音效已开启，点击关闭；与背景音乐分别控制" : "点击开启吃食物、吞噬和技能音效";
    $("effects-label").textContent = !supported ? "音效不可用" : enabled ? "音效开启" : "音效关闭";
  }

  renderLeaderboard(leaderboard) {
    const signature = JSON.stringify({ entries: leaderboard.entries.map(entry => [entry.ownerId, entry.name, entry.rank, entry.movement, Math.round(entry.mass), entry.cells, entry.color]),
      kind: leaderboard.kind, lives: leaderboard.entries.map(entry => [entry.lives, entry.kills]), playerLives: leaderboard.player?.lives,
      playerKills: leaderboard.player?.kills, playerRank: leaderboard.player?.rank, playerMass: Math.round(leaderboard.player?.mass ?? 0), networkAge: Math.round(leaderboard.networkAge ?? -1), total: leaderboard.total });
    if (signature === this.lastLeaderboard) return;
    this.lastLeaderboard = signature;
    const rows = leaderboard.entries.map(entry => {
      const row = document.createElement("li");
      row.className = `leaderboard-row${entry.isPlayer ? " is-player" : ""}`;
      row.dataset.owner = entry.ownerId;
      const rank = document.createElement("span");
      rank.className = "rank-position";
      rank.textContent = entry.rank;
      const movement = document.createElement("span");
      movement.className = "rank-change";
      const delta = Number(entry.movement) || 0;
      movement.dataset.trend = delta > 0 ? "up" : delta < 0 ? "down" : "steady";
      movement.textContent = delta > 0 ? `↑${delta}` : delta < 0 ? `↓${Math.abs(delta)}` : "—";
      const name = document.createElement("span");
      name.className = "rank-name";
      name.style.setProperty("--ball-color", entry.color);
      name.textContent = entry.cells > 1 ? `${entry.name} · ${entry.cells}球` : entry.name;
      const mass = document.createElement("strong");
      mass.textContent = leaderboard.kind === "survival" ? `${entry.lives}命 · ${entry.kills}杀` : number(entry.mass);
      mass.title = `总质量 ${number(entry.mass)} m`;
      if (entry.eliminated) row.classList.add("is-eliminated");
      row.append(rank, movement, name, mass);
      return row;
    });
    $("leaderboard-list").replaceChildren(...rows);
    $("leaderboard-caption").textContent = leaderboard.kind === "survival" ? "命数 → 击败 → 质量" : "总质量 · 前五名";
    $("leaderboard-sync").textContent = leaderboard.networkAge == null ? "实时同步" : `同步 ${Math.round(leaderboard.networkAge)} ms 前`;
    $("leaderboard-rank").textContent = leaderboard.player ? `你 #${leaderboard.player.rank}` : "已出局";
    $("leaderboard-player").textContent = leaderboard.player ?
      `你的名次 ${leaderboard.player.rank} / ${leaderboard.total} · ${leaderboard.kind === "survival" ? `${leaderboard.player.lives}命 · ${leaderboard.player.kills}次击败 · ` : ""}${number(leaderboard.player.mass)} m` : "本局全部分身已被吞噬";
  }

  renderRecord({ highScore, status, pending }) {
    $("high-score").textContent = status === "loading" && !highScore ? "—" : number(highScore);
    $("focus-best").textContent = $("high-score").textContent;
    const messages = {
      loading: "正在读取记录…", pending: "新纪录将在数秒内保存", saving: "正在保存最高分…",
      saved: "最高分已同步至本机数据库", offline: pending ? "连接中断 · 分数待同步，自动重试" : "数据库暂不可用 · 自动重试",
    };
    $("save-status").textContent = messages[status];
    $("save-status").classList.toggle("error", status === "offline");
  }

  render(snapshot, feedback = { skills: {}, hotspots: { phase: "normal" } }) {
    this.lastSnapshot = snapshot;
    const survival = snapshot.survival;
    $("survival-hud").hidden = !survival || snapshot.state === "ready";
    $("survival-hud").dataset.urgent = String(Boolean(survival && survival.remaining <= 30));
    if (survival) {
      $("survival-lives").textContent = survival.player.lives;
      $("survival-time").textContent = formatTime(Math.ceil(survival.remaining));
      $("survival-kills").textContent = survival.player.kills;
      $("survival-active").textContent = `${survival.active} / ${survival.total}`;
    }
    $("arena-mode-title").textContent = snapshot.network ? "联机生存" : (snapshot.state === "ready" ? this.mode : snapshot.mode) === "survival" ? "生存 · 5 分钟" : "自由生长";
    $("opponent-legend").textContent = snapshot.network ? "其他玩家" : "AI 小球";
    $("restart-button").disabled = Boolean(snapshot.network);
    if (snapshot.network) $("game-status").textContent = snapshot.spectating ? "观战中" : snapshot.state === "playing" ? "联机中" : snapshot.state === "gameover" ? "本局结束" : "准备室";
    this.renderFeedback(snapshot, feedback);
    $("current-score").textContent = number(snapshot.score);
    $("elapsed-time").textContent = formatTime(snapshot.elapsed);
    $("player-mass").textContent = number(snapshot.player.mass);
     $("player-speed").textContent = number(snapshot.player.speed);
    $("eaten-balls").textContent = number(snapshot.eatenBalls);
    const { stage, difficulty, split, spore } = snapshot;
    $("growth-progress").style.width = `${stage.progress * 100}%`;
    $("growth-hint").textContent = `还差 ${number(stage.target - snapshot.score)} 分，迈向下一阶段`;
    $("stage-name").textContent = stage.title;
    $("stage-target").textContent = `${number(snapshot.score)} / ${number(stage.target)}`;
    $("canvas-stage").textContent = `阶段 ${stage.index + 1} · ${stage.title}`;
    $("canvas-goal").textContent = `目标 ${number(stage.target)} 分`;
    $("difficulty-label").textContent = `Lv.${difficulty.level + 1} · ${difficulty.title}`;
    $("focus-score").textContent = number(snapshot.score);
    $("focus-time").textContent = formatTime(snapshot.elapsed);
    $("focus-mass").textContent = number(snapshot.player.mass);
    $("group-mass").textContent = number(snapshot.player.mass);
    $("hotspot-status").textContent = `富集区 · ${Math.ceil(snapshot.hotspots.remaining)}s 后换位`;
    this.renderLeaderboard({ ...snapshot.leaderboard, networkAge: snapshot.network?.stateAge == null ? null : snapshot.network.stateAge * 1000 });
    $("ability-panel").hidden = snapshot.state === "ready" || snapshot.state === "gameover" || snapshot.spectating;
    $("split-button").disabled = snapshot.state !== "playing" || !split.ready;
    $("split-button").dataset.state = split.count >= split.maxCells || !split.affordable ? "low" : split.cooldown > 0 ? "cooldown" : "ready";
    $("split-label").textContent = split.count >= split.maxCells ? "分身已满" : split.cooldown > 0 ? `冷却 ${split.cooldown.toFixed(1)}s` : !split.affordable ? "单球需 72" : "分裂就绪";
    $("split-progress").style.width = `${(1 - split.cooldown / CONFIG.split.cooldown) * 100}%`;
    const safeSpore = spore || { ready: false, affordable: false, cooldown: 0, progress: 0 };
    $("spore-button").disabled = snapshot.state !== "playing" || !safeSpore.ready;
    $("spore-button").dataset.state = !safeSpore.affordable ? "low" : safeSpore.cooldown > 0 ? "cooldown" : "ready";
    $("spore-label").textContent = safeSpore.cooldown > 0 ? `冷却 ${safeSpore.cooldown.toFixed(1)}s` : !safeSpore.affordable ? "质量不足" : "吐孢子就绪";
    $("spore-progress").style.width = `${Math.max(0, Math.min(1, safeSpore.progress)) * 100}%`;
    $("cell-count").textContent = `${split.count} / ${split.maxCells} 分身`;
    const largestMass = snapshot.player.largestMass ?? snapshot.player.mass;
    const smallestMass = snapshot.player.smallestMass ?? snapshot.player.mass;
    $("cell-quality").textContent = split.count > 1 ? `最大 ${number(largestMass)} · 最小 ${number(smallestMass)}` : `当前 ${number(largestMass)}`;
    $("merge-status").textContent = split.count < 2 ? "长大后右键分身" : split.merging ? "正在靠拢合体" : `${split.mergeRemaining.toFixed(1)}s 后可合体`;
    $("protection-hint").hidden = snapshot.state !== "playing" || snapshot.protectionRemaining <= 0;
    $("protection-seconds").textContent = Math.ceil(snapshot.protectionRemaining);
    if (this.lastState === snapshot.state) return;
    this.lastState = snapshot.state;
    this.renderOverlay(snapshot);
  }

  renderOverlay(snapshot) {
    const state = snapshot.state;
    const labels = { ready: "准备就绪", playing: "生长中", paused: "已暂停", gameover: "本局结束" };
    $("game-status").textContent = labels[state];
    $("pause-button").disabled = Boolean(snapshot.network) || (state !== "playing" && state !== "paused");
    $("pause-label").textContent = state === "paused" ? "继续" : "暂停";
    $("game-overlay").hidden = state === "playing";
    $("result-stats").hidden = state !== "gameover";
    $("overlay-orbit").hidden = state === "gameover" || Boolean(snapshot.network);
    $("mode-selector").hidden = Boolean(snapshot.network?.room) || (state !== "ready" && state !== "gameover");
    $("start-button").hidden = Boolean(snapshot.network);
    $("mode-description").textContent = this.mode === "survival" ?
      "每人 3 命 · 吃人加命 · 36 m 复活 · 限时 5 分钟" : "自由探索，全部分身被吃后结束。";
    if (this.mode === "multiplayer") $("mode-description").textContent = "同一局域网 · 真人不足时自动补人机 · 全员准备后开局";
    $("arena-mode-title").textContent = snapshot.network ? "联机生存" : (state === "ready" ? this.mode : snapshot.mode) === "survival" ? "生存 · 5 分钟" : "自由生长";
    $("survival-result").hidden = !(state === "gameover" && snapshot.survival);
    if (state === "playing") return;

    let copy = state === "paused" ? {
      eyebrow: "TAKE A BREATH", title: "歇一会儿，也没关系", description: "球场已暂停，你的微光会在这里等你。", button: "继续生长", footnote: "点击继续，或按空格键返回球场",
    } : state === "gameover" ? {
      eyebrow: this.isNewRecord ? "A NEW PERSONAL BEST" : "EVERY END IS A NEW BEGINNING",
      title: this.isNewRecord ? "新的纪录，新的你" : "这次的微光，已被记住",
      description: `你的全部分身已被吞噬，最后的对手是「${snapshot.killer}」。再试一次，继续生长。`,
      button: "再来一局", footnote: "每一次重新开始，都有新的可能",
    } : {
       eyebrow: "A LITTLE LIGHT, A BIG ADVENTURE", title: "准备好，开始生长", description: "收集微光，长大后右键或按 Q 分身追击，左键或按 E 吐出孢子；绿色刺球会把你扎散。", button: "开始游戏", footnote: "开局自动专注 · F 键随时切换",
    };
    if (state === "ready" && this.mode === "survival") copy = {
      eyebrow: "THREE LIVES. FIVE MINUTES.", title: "留住生命，争夺球场",
      description: "你与 13 位 AI 均以 3 条命、36 m 开局。吞噬对手最后一个分身加 1 命；被吃扣 1 命，有命立即复活，3 秒保护。",
      button: "开始生存", footnote: "5 分钟 · 命数优先排名 · 命数不限上限",
    };
    if (state === "gameover" && snapshot.survival) {
      const { result } = snapshot;
      copy = {
        eyebrow: result.won ? "SURVIVAL CHAMPION" : "SURVIVAL ROUND COMPLETE",
        title: result.reason === "eliminated" ? "生命耗尽，本局结束" : result.won ? "生存冠军，守住了微光" : "时间到，生存挑战完成",
        description: result.reason === "eliminated" ? `最后的对手是「${snapshot.killer}」。本局获得第 ${result.rank} 名，重开可再挑战。` :
          result.reason === "last-survivor" ? "你成为场上最后一位幸存者，提前获胜。" :
          `五分钟结束，${result.winners.length > 1 ? "并列领先" : "本局领先"}：${result.winners.join("、")}。按剩余命数、击败数、总质量结算。`,
        button: "再来一局", footnote: this.isNewRecord ? "刷新历史最高分 · 正在自动保存" : "选择模式，再开始下一局",
      };
      $("survival-result").textContent = `第 ${result.rank} / ${snapshot.survival.total} 名 · 剩余 ${result.lives} 命 · 击败 ${result.kills} 次 · 复活 ${result.deaths - (result.lives === 0 ? 1 : 0)} 次`;
    }
    if (snapshot.network && state === "ready") copy = {
      eyebrow: "PLAY TOGETHER", title: snapshot.network.room ? "朋友到齐，就出发" : "和朋友一起，守住微光",
      description: snapshot.network.room ? "每人 3 条命，吃人加命，36 m 复活。真人全部准备后，由房主开始五分钟生存局，空位自动补人机。" :
        "连接同一 Wi-Fi，创建房间，邀请 0～3 位朋友一起玩；真人不足的空位会自动补人机。", footnote: "联机期间持续计时 · 退出或断线按出局处理",
      button: "开始对局",
    };
    $("overlay-eyebrow").textContent = copy.eyebrow;
    $("overlay-title").textContent = copy.title;
    $("overlay-description").textContent = copy.description;
    $("start-label").textContent = copy.button;
    $("overlay-footnote").textContent = copy.footnote;
    $("result-score").textContent = number(snapshot.score);
    $("result-time").textContent = formatTime(snapshot.elapsed);
  }

  toast(message) {
    clearTimeout(this.toastTimer);
    $("toast").textContent = message;
    $("toast").hidden = false;
    this.toastTimer = setTimeout(() => { $("toast").hidden = true; }, 2200);
  }
}
