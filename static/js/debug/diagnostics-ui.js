const $ = id => document.getElementById(id);

function metric(value, suffix = "", digits = 0) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${number.toFixed(digits)}${suffix}`;
}

function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
  } catch {
    return "—";
  }
}

/**
 * 诊断面板只读取 Renderer.metrics 和会话快照，不另建高频采样器。
 * 面板关闭时只刷新错误计数，避免诊断本身增加主循环负担。
 */
export class DiagnosticsUI {
  constructor({
    getSession,
    renderer,
    errorMonitor,
    onOpen = () => {},
    onClose = () => {},
  }) {
    this.getSession = getSession;
    this.renderer = renderer;
    this.errorMonitor = errorMonitor;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.dialog = $("diagnostics-dialog");
    this.bind();
    this.unsubscribe = errorMonitor.subscribe(errors => this.renderErrors(errors));
    this.renderErrors(errorMonitor.snapshot);
  }

  bind() {
    $("diagnostics-open").addEventListener("click", () => this.open());
    $("diagnostics-close").addEventListener("click", () => this.dialog.close());
    this.dialog.addEventListener("close", () => {
      this.onClose();
      $("diagnostics-open").focus({ preventScroll: true });
    });
    $("diagnostics-clear").addEventListener("click", () => {
      this.errorMonitor.clear();
      $("diagnostics-error-status").textContent = "错误记录已清空。";
    });
  }

  open() {
    if (this.dialog.open) return;
    this.onOpen();
    this.render();
    this.dialog.showModal();
  }

  render(snapshot = null) {
    const errorCount = this.errorMonitor.snapshot.length;
    $("diagnostics-error-count").textContent = String(errorCount);
    $("diagnostics-error-count").hidden = errorCount === 0;
    if (!this.dialog.open) return;

    const current = snapshot || this.getSession()?.getSnapshot?.();
    const metrics = this.renderer.metrics.snapshot();
    const network = current?.network || {};
    $("diag-fps").textContent = metric(metrics?.fps, "", 0);
    $("diag-simulation").textContent = metric(metrics?.simulationMs, " ms", 2);
    $("diag-collision").textContent = metric(metrics?.collisionMs, " ms", 2);
    $("diag-rtt").textContent = network.rtt === null || network.rtt === undefined ? "—" : metric(network.rtt, " ms");
    $("diag-jitter").textContent = network.jitter === undefined ? "—" : metric(network.jitter, " ms");
    $("diag-interpolation").textContent = network.interpolationDelay === undefined ? "—" :
      metric(network.interpolationDelay, " ms");
    $("diag-state-age").textContent = network.stateAge === null || network.stateAge === undefined ? "—" :
      metric(Number(network.stateAge) * 1000, " ms");
    $("diag-cells").textContent = metric(metrics?.cellCount);
    $("diag-ai").textContent = metric(metrics?.aiCount);
    $("diag-alive").textContent = metric(metrics?.aliveCount);
    $("diag-connection").textContent = network.connection ?
      `${network.connection} · ${network.quality || "unknown"}` : "local · 本地";
    $("diag-draw-p95").textContent = metric(metrics?.drawP95, " ms", 2);
  }

  renderErrors(errors = this.errorMonitor.snapshot) {
    const count = errors.length;
    if ($("diagnostics-error-count")) {
      $("diagnostics-error-count").textContent = String(count);
      $("diagnostics-error-count").hidden = count === 0;
    }
    const list = $("diagnostics-error-list");
    if (!list) return;
    if (!count) {
      const empty = document.createElement("li");
      empty.className = "diagnostics-empty";
      empty.textContent = "当前页面没有捕获到脚本错误。";
      list.replaceChildren(empty);
      return;
    }
    list.replaceChildren(...errors.map(error => {
      const item = document.createElement("li");
      const heading = document.createElement("div");
      const source = document.createElement("strong");
      const time = document.createElement("time");
      const message = document.createElement("p");
      source.textContent = error.source;
      time.textContent = formatTime(error.time);
      message.textContent = error.message;
      heading.append(source, time);
      item.append(heading, message);
      if (error.stack) {
        const details = document.createElement("details");
        const summary = document.createElement("summary");
        const stack = document.createElement("pre");
        summary.textContent = "查看堆栈";
        stack.textContent = error.stack;
        details.append(summary, stack);
        item.append(details);
      }
      return item;
    }));
  }

  dispose() {
    this.unsubscribe?.();
  }
}
