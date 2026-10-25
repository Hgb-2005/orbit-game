import { CONFIG } from "./config.js";
import { Camera } from "./camera.js";
import { InputController } from "./input.js";
import { Renderer } from "./renderer.js";
import { LocalSession } from "./session.js";
import { ScoreService } from "./services/scores.js";
import { GameUI } from "./ui.js";
import { BackgroundMusic } from "./audio/music.js";
import { SoundEffects } from "./audio/effects.js";
import { VisualFeedback } from "./presentation/feedback.js";
import { RemoteSession } from "./network/remote-session.js";
import { LobbyUI } from "./network/lobby-ui.js";

const canvas = document.getElementById("game-canvas");
const ui = new GameUI();
const localSession = new LocalSession();
let session = localSession;
let remoteSession = null;
const camera = new Camera();
const renderer = new Renderer(canvas, camera);
const input = new InputController(canvas);
const scores = new ScoreService(record => ui.renderRecord(record));
const music = new BackgroundMusic(state => ui.renderMusic(state));
const effects = new SoundEffects(() => music.context, state => ui.renderEffects(state), { supported: music.supported });
const feedback = new VisualFeedback();
const lobby = new LobbyUI(() => remoteSession);
renderer.theme = ui.theme;
ui.renderMusic(music.getSnapshot());
ui.renderEffects(effects.getSnapshot());

function unlockAudio() {
  void music.unlock({ force: effects.enabled && session.state === "playing" });
}

let accumulator = 0;
let lastFrame = performance.now();
let lastHudUpdate = 0;
let lastObservedScore = -1;
let recordAtStart = 0;

function syncScore() {
  if (session instanceof RemoteSession) return;
  const snapshot = session.getSnapshot();
  scores.observe(snapshot.score);
  void scores.flush();
}

function renderHud(snapshot = session.getSnapshot()) {
  ui.render(snapshot, feedback.update(snapshot));
  lobby.render(snapshot);
  renderer.labelObstacles = ui.getLabelObstacles(canvas.getBoundingClientRect());
}

function start(forceNewGame = false) {
  if (session instanceof RemoteSession) return;
  const isNewRound = session.state !== "paused" || forceNewGame;
  if (session.state === "paused" && !forceNewGame) {
    session.resume();
  } else {
    if (session.state !== "ready") syncScore();
    recordAtStart = scores.highScore;
    ui.focusOnStart();
    renderer.resize();
    session.start({ width: renderer.width, height: renderer.height }, ui.mode);
    renderer.resetEffects();
    feedback.reset();
    ui.resetRound();
    ui.isNewRecord = false;
    lastObservedScore = -1;
    const snapshot = session.getSnapshot();
    camera.update(snapshot.player, snapshot.bounds, renderer.width, renderer.height, 0, true);
  }
  input.reset();
  accumulator = 0;
  lastFrame = performance.now();
  canvas.focus({ preventScroll: true });
  music.setGameState(session.state, { restart: isNewRound });
  effects.setGameState(session.state, { restart: isNewRound });
  unlockAudio();
  renderHud();
}

function togglePause() {
  if (session instanceof RemoteSession) {
    session.stop(); input.reset();
    ui.toast("已停止操作，联机对局继续；点击画布恢复控制");
    return;
  }
  if (session.state === "playing") {
    session.pause();
    input.reset();
    syncScore();
  } else if (session.state === "paused") {
    start();
  } else if (session.state === "ready") {
    start();
  }
  music.setGameState(session.state);
  effects.setGameState(session.state);
  renderHud();
}

function restart() {
  if (session instanceof RemoteSession) {
    ui.toast("联机局结束后，由房主返回准备室开始下一局");
    return;
  }
  start(true);
  ui.toast("新的一局，新的微光");
}

function toggleFocus() {
  ui.setFocus(!ui.focusMode, true);
  canvas.focus({ preventScroll: true });
}

ui.onModeChange = mode => {
  if (mode === "multiplayer") {
    syncScore();
    remoteSession = new RemoteSession(new LocalSession().getSnapshot(), () => {
      if (session !== remoteSession) return;
      ui.lastState = "";
      music.setGameState(session.state); effects.setGameState(session.state);
      renderHud();
    });
    session = remoteSession;
  } else {
    remoteSession?.close(); remoteSession = null;
    session = localSession;
  }
  input.reset(); feedback.reset(); renderer.resetEffects(); ui.resetRound(); ui.lastState = "";
  music.setGameState(session.state); effects.setGameState(session.state);
  renderHud();
};

function handleEvents(events) {
  if (events.some(event => event.type === "networkstart")) {
    recordAtStart = scores.highScore;
    ui.focusOnStart(); renderer.resize(); renderer.resetEffects(); feedback.reset(); ui.resetRound(); input.reset();
    ui.isNewRecord = false; lastObservedScore = -1;
    const snapshot = session.getSnapshot();
    camera.update(snapshot.player, snapshot.bounds, renderer.width, renderer.height, 0, true);
    music.setGameState(session.state, { restart: true }); effects.setGameState(session.state, { restart: true });
    unlockAudio();
    canvas.focus({ preventScroll: true });
  }
  if (events.some(event => event.type === "respawn" && event.isPlayer)) {
    input.reset(); feedback.reset(); renderer.resetEffects();
    const snapshot = session.getSnapshot();
    camera.update(snapshot.player, snapshot.bounds, renderer.width, renderer.height, 0, true);
  }
  renderer.addEvents(events); ui.handleEvents(events); effects.handleEvents(events);
  if (session instanceof RemoteSession && events.some(event => event.type === "gameover")) {
    music.setGameState("gameover"); effects.setGameState("gameover"); input.reset();
  }
  if (session instanceof RemoteSession && events.some(event => event.type === "record_saved")) {
    void scores.load();
  }
}

ui.onFocusChange = () => {
  input.reset();
  renderer.resize();
  const snapshot = session.getSnapshot();
  camera.update(snapshot.player, snapshot.bounds, renderer.width, renderer.height, 0, true);
  window.scrollTo({ top: 0, behavior: "auto" });
};
ui.bind({
  start, pause: togglePause, restart, focus: toggleFocus,
  theme: theme => { renderer.theme = theme; },
  split: () => { input.requestSplit(); canvas.focus({ preventScroll: true }); },
  spore: () => { input.requestSpore(); canvas.focus({ preventScroll: true }); },
  music: () => { music.setEnabled(!music.enabled); unlockAudio(); },
  volume: value => { music.setVolume(value); unlockAudio(); },
  effects: () => { effects.setEnabled(!effects.enabled); unlockAudio(); },
});
input.onCommand = command => {
  if (command === "restart") restart();
  else if (command === "focus") toggleFocus();
  else togglePause();
};

// 固定步长模拟，显示帧率不会影响移动速度。切走页面时暂停，避免后台追帧。
function frame(now) {
  const dt = Math.max(0, Math.min((now - lastFrame) / 1000, CONFIG.simulation.maxFrameTime));
  lastFrame = now;
  if (camera.width !== renderer.width || camera.height !== renderer.height) {
    const snapshot = session.getSnapshot();
    camera.update(snapshot.player, snapshot.bounds, renderer.width, renderer.height, 0, true);
    input.reset();
    lastHudUpdate = 0;
  }
  if (session instanceof RemoteSession) {
    const snapshot = session.getSnapshot();
    const controls = input.getInput(camera.worldToScreen(snapshot.player), camera.getView());
    handleEvents(session.step(dt, controls));
    accumulator = 0;
  } else if (session.state === "playing") {
    accumulator += dt;
    while (accumulator >= CONFIG.simulation.step && session.state === "playing") {
      const controls = input.getInput(camera.worldToScreen(session.getSnapshot().player), camera.getView());
      const events = session.step(CONFIG.simulation.step, controls);
      handleEvents(events);
      accumulator -= CONFIG.simulation.step;
    }
    if (session.state === "gameover") {
      music.setGameState("gameover");
      effects.setGameState("gameover");
      ui.isNewRecord = session.getSnapshot().score > recordAtStart;
      syncScore();
      input.reset();
    }
  } else {
    accumulator = 0;
  }

  const snapshot = session.getSnapshot();
  if (!(session instanceof RemoteSession) && snapshot.score !== lastObservedScore) {
    scores.observe(snapshot.score);
    lastObservedScore = snapshot.score;
  }
  camera.update(snapshot.player, snapshot.bounds, renderer.width, renderer.height, dt);
  const visualState = feedback.update(snapshot);
  // HUD 限制到 10Hz，避免每个显示帧都触发不必要的 DOM 更新。
  if (now - lastHudUpdate > 100 || ui.lastState !== snapshot.state) {
    ui.render(snapshot, visualState);
    lobby.render(snapshot);
    renderer.labelObstacles = ui.getLabelObstacles(canvas.getBoundingClientRect());
    lastHudUpdate = now;
  }
  renderer.draw(snapshot, dt, visualState);
  requestAnimationFrame(frame);
}

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    if (session instanceof RemoteSession) { session.stop(); input.reset(); }
    else if (session.state === "playing") togglePause();
    scores.flushOnExit();
  } else remoteSession?.resumeInput();
});
window.addEventListener("blur", () => {
  if (session instanceof RemoteSession) session.stop();
  else if (session.state === "playing") togglePause();
});
window.addEventListener("focus", () => remoteSession?.resumeInput());
canvas.addEventListener("pointerdown", () => remoteSession?.resumeInput());
window.addEventListener("pagehide", () => {
  syncScore();
  scores.flushOnExit();
  music.setGameState("paused");
  effects.setGameState("paused");
  remoteSession?.close();
});
window.addEventListener("online", () => { void scores.load(); });
setInterval(() => {
  if (scores.status === "offline") void scores.load();
  else void scores.flush();
}, 5000);

const initialSnapshot = session.getSnapshot();
camera.update(initialSnapshot.player, initialSnapshot.bounds, renderer.width, renderer.height, 0, true);
renderHud(initialSnapshot);
if (/^\d{6}$/.test(new URLSearchParams(location.search).get("room") ?? "")) {
  ui.mode = "multiplayer"; document.getElementById("game-mode").value = "multiplayer";
  ui.onModeChange("multiplayer");
}
void scores.load();
requestAnimationFrame(frame);
