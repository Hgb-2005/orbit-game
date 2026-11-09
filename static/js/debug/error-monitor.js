const DEFAULT_LIMIT = 20;
const MAX_MESSAGE_LENGTH = 520;

export function describeError(error, source = "runtime") {
  const value = error && typeof error === "object" ? error : null;
  const rawMessage = value?.message ?? value?.reason?.message ?? error ?? "未知错误";
  const message = String(rawMessage).replace(/\s+/g, " ").trim().slice(0, MAX_MESSAGE_LENGTH) || "未知错误";
  const stack = typeof value?.stack === "string" ? value.stack.split("\n").slice(0, 6).join("\n") : "";
  return {
    source: String(source || "runtime"),
    message,
    stack: stack.slice(0, 1600),
    time: Date.now(),
  };
}

/**
 * 全局错误仅保存在页面内，用于诊断面板；不会上传统计服务，也不会阻塞游戏循环。
 * 事件监听使用捕获阶段，脚本顶层异常和未处理 Promise 拒绝都会进入有界队列。
 */
export class ErrorMonitor {
  constructor(target = globalThis, { limit = DEFAULT_LIMIT } = {}) {
    this.target = target;
    this.limit = Math.max(1, Math.min(100, Math.round(Number(limit) || DEFAULT_LIMIT)));
    this.errors = [];
    this.listeners = new Set();
    // 复用同一个 options 对象，浏览器与 Node EventTarget 都能可靠移除捕获监听。
    this.errorListenerOptions = { capture: true };
    this.handleError = event => {
      const error = event?.error || event?.message || "脚本运行错误";
      this.capture(error, event?.filename ? `script:${event.filename}` : "script");
    };
    this.handleRejection = event => this.capture(event?.reason, "promise");
    target?.addEventListener?.("error", this.handleError, this.errorListenerOptions);
    target?.addEventListener?.("unhandledrejection", this.handleRejection);
  }

  get snapshot() {
    return Object.freeze(this.errors.map(error => Object.freeze({ ...error })));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  capture(error, source = "runtime") {
    const entry = describeError(error, source);
    this.errors.unshift(entry);
    if (this.errors.length > this.limit) this.errors.length = this.limit;
    for (const listener of this.listeners) listener(this.snapshot);
    return entry;
  }

  clear() {
    this.errors = [];
    for (const listener of this.listeners) listener(this.snapshot);
  }

  dispose() {
    this.target?.removeEventListener?.("error", this.handleError, this.errorListenerOptions);
    this.target?.removeEventListener?.("unhandledrejection", this.handleRejection);
    this.listeners.clear();
  }
}
