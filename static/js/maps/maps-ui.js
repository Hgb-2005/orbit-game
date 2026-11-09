import { cloneMap, encodeMap, MAP_LIMITS, normalizeMap } from "./map-schema.js";
import { MapStore } from "./map-store.js";
import { MapEditor } from "./map-editor.js";

const $ = id => document.getElementById(id);

function mapOptionLabel(map) {
  const spikes = map.spikes?.length ?? map.spikes ?? 0;
  const obstacles = map.obstacles?.length ?? map.obstacles ?? 0;
  return `${map.name} · ${map.width}×${map.height} · 刺 ${spikes} · 障碍 ${obstacles}`;
}

/** 地图工坊与首页入口的 DOM 适配层；协议和编辑状态分别位于 schema/editor。 */
export class MapsUI {
  constructor(store = new MapStore(), {
    onPlay = () => {},
    onOpen = () => {},
    onClose = () => {},
    getRules = () => ({}),
    applyRules = () => {},
  } = {}) {
    this.store = store;
    this.onPlay = onPlay;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.getRules = getRules;
    this.applyRules = applyRules;
    this.current = store.active();
    this.signature = "";
    this.editor = new MapEditor($("map-editor-canvas"), {
      onChange: map => {
        this.current = map;
        this.updateSelected(map);
      },
    });
    this.bind();
    this.render();
  }

  bind() {
    $("maps-open").addEventListener("click", () => {
      this.onOpen();
      this.open();
    });
    $("maps-close").addEventListener("click", () => $("maps-dialog").close());
    $("maps-dialog").addEventListener("click", event => {
      if (event.target === $("maps-dialog")) $("maps-dialog").close();
    });
    $("maps-dialog").addEventListener("close", () => {
      this.editor.draw();
      this.onClose();
    });
    $("map-list").addEventListener("change", event => this.load(event.target.value));
    $("map-new").addEventListener("click", () => this.newMap());
    $("map-save").addEventListener("click", () => this.save());
    $("map-delete").addEventListener("click", () => this.remove());
    $("map-undo").addEventListener("click", () => this.editor.undo());
    $("map-selected-delete").addEventListener("click", () => this.editor.removeSelected());
    $("map-tool").addEventListener("change", event => {
      this.editor.setTool(event.target.value, Number($("map-radius").value));
      this.updateRadiusControl();
    });
    $("map-radius").addEventListener("input", event => {
      $("map-radius-value").textContent = event.target.value;
      this.editor.setRadius(event.target.value);
    });
    for (const id of ["map-name", "map-id", "map-width", "map-height"]) {
      $(id).addEventListener("change", () => this.applyMetadata());
    }
    $("map-apply-metadata").addEventListener("click", () => this.applyMetadata());
    $("map-export").addEventListener("click", () => {
      $("map-json").value = this.store.exportJson(this.editor.map);
      $("map-status").textContent = "JSON 已生成，可复制或下载文件。";
    });
    $("map-download").addEventListener("click", () => this.download());
    $("map-import").addEventListener("click", () => this.importJson());
    $("map-file").addEventListener("change", async event => {
      const file = event.target.files?.[0];
      if (!file) return;
      $("map-json").value = await file.text();
      this.importJson();
      event.target.value = "";
    });
    $("map-copy-link").addEventListener("click", () => this.copyLink());
    $("map-play").addEventListener("click", () => this.play());
    $("map-preset-save").addEventListener("click", () => this.savePreset());
    $("map-preset-load").addEventListener("click", () => this.loadPreset());
    $("map-preset-delete").addEventListener("click", () => this.removePreset());
  }

  open() {
    $("maps-dialog").showModal();
    requestAnimationFrame(() => this.editor.resize());
  }

  render() {
    const maps = this.store.list();
    const options = maps.map(map => {
      const option = document.createElement("option");
      option.value = map.id;
      option.textContent = mapOptionLabel(map);
      return option;
    });
    $("map-list").replaceChildren(...options);
    this.load(this.current.id, { silent: true });
    this.renderPresets();
    this.updateRoomOptions();
  }

  updateRoomOptions() {
    const maps = this.store.list();
    for (const id of ["new-room-map", "room-map"]) {
      const select = $(id);
      if (!select) continue;
      const previous = select.value;
      select.replaceChildren(...maps.map(map => {
        const option = document.createElement("option");
        option.value = map.id;
        option.textContent = `${map.name} · ${map.width}×${map.height}`;
        return option;
      }));
      if (maps.some(map => map.id === previous)) select.value = previous;
      else select.value = this.store.active().id;
    }
  }

  load(id, { silent = false } = {}) {
    const map = this.store.list().find(item => item.id === id) ?? this.store.active();
    this.current = cloneMap(map);
    $("map-list").value = map.id;
    $("map-name").value = map.name;
    $("map-id").value = map.id;
    $("map-width").value = map.width;
    $("map-height").value = map.height;
    $("map-delete").disabled = map.id === "default";
    this.editor.setMap(map);
    $("map-json").value = this.store.exportJson(map);
    if (!silent) $("map-status").textContent = `已载入「${map.name}」。`;
  }

  applyMetadata() {
    const width = Number($("map-width").value);
    const height = Number($("map-height").value);
    if (!Number.isInteger(width) || !Number.isInteger(height)) {
      this.status("地图宽高必须是整数。", true); return;
    }
    const map = {
      ...this.editor.map,
      name: $("map-name").value,
      id: $("map-id").value.trim().toLowerCase(),
      width: Math.max(MAP_LIMITS.minWidth, Math.min(MAP_LIMITS.maxWidth, width)),
      height: Math.max(MAP_LIMITS.minHeight, Math.min(MAP_LIMITS.maxHeight, height)),
    };
    if (width !== map.width || height !== map.height) this.status("尺寸已限制到地图允许范围。", true);
    this.editor.setMap(map);
  }

  newMap() {
    const id = `map-${Date.now().toString(36)}`;
    const map = normalizeMap({
      version: 1, id, name: "新球场", width: 3200, height: 2200,
      spawnPoints: [
        { id: "spawn-1", x: 800, y: 550 }, { id: "spawn-2", x: 2400, y: 1650 },
        { id: "spawn-3", x: 2400, y: 550 }, { id: "spawn-4", x: 800, y: 1650 },
      ],
      spikes: [], obstacles: [],
    }, { strict: true });
    this.current = map;
    this.loadIntoEditor(map);
    this.status("已创建空白球场，编辑后点击保存。");
  }

  loadIntoEditor(map) {
    $("map-name").value = map.name;
    $("map-id").value = map.id;
    $("map-width").value = map.width;
    $("map-height").value = map.height;
    $("map-list").value = "";
    $("map-delete").disabled = true;
    this.editor.setMap(map);
    $("map-json").value = this.store.exportJson(map);
  }

  save() {
    try {
      const map = this.store.save(this.editor.map);
      this.store.setActive(map);
      this.current = map;
      this.status(`「${map.name}」已保存并设为当前单机地图。`);
      this.render();
    } catch (error) { this.status(error.message, true); }
  }

  remove() {
    try {
      const id = this.editor.map.id;
      this.store.remove(id);
      this.current = this.store.active();
      this.render();
      this.status("地图已删除，当前地图回到标准场。");
    } catch (error) { this.status(error.message, true); }
  }

  importJson() {
    try {
      const map = normalizeMap(JSON.parse($("map-json").value), { strict: true });
      this.store.save(map);
      this.current = map;
      this.load(map.id);
      this.status(`「${map.name}」导入成功。`);
      this.updateRoomOptions();
    } catch (error) { this.status(`导入失败：${error.message}`, true); }
  }

  download() {
    try {
      const map = normalizeMap(this.editor.map, { strict: true });
      const blob = new Blob([this.store.exportJson(map)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `${map.id}.orbit-map.json`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      this.status("地图 JSON 已下载。");
    } catch (error) { this.status(`导出失败：${error.message}`, true); }
  }

  async copyLink() {
    try {
      const url = new URL(location.href);
      url.search = "";
      url.searchParams.set("map", encodeMap(this.store.save(this.editor.map)));
      await navigator.clipboard.writeText(url.href);
      this.status("分享链接已复制；打开链接会自动载入这张地图。");
    } catch (error) { this.status(`复制失败，请先保存并检查浏览器剪贴板权限：${error.message}`, true); }
  }

  play() {
    try {
      const map = this.store.save(this.editor.map);
      this.store.setActive(map);
      this.current = map;
      this.render();
      $("maps-dialog").close();
      this.onPlay(map);
    } catch (error) { this.status(`无法开始：${error.message}`, true); }
  }

  renderPresets() {
    const presets = this.store.presets();
    const options = presets.map(preset => {
      const option = document.createElement("option");
      option.value = preset.name;
      option.textContent = `${preset.name} · ${preset.map.name}`;
      return option;
    });
    $("map-preset-list").replaceChildren(...options);
    if (!presets.length) {
      const option = document.createElement("option");
      option.value = "";
      option.textContent = "尚无对局预设";
      $("map-preset-list").append(option);
    }
  }

  savePreset() {
    try {
      const name = $("map-preset-name").value;
      const preset = this.store.savePreset(name, this.editor.map, this.getRules());
      this.renderPresets();
      $("map-preset-list").value = String(name).trim().slice(0, 28);
      this.status(`地图与当前规则已保存为「${preset.name}」。`);
    } catch (error) { this.status(error.message, true); }
  }

  loadPreset() {
    const preset = this.store.findPreset($("map-preset-list").value);
    if (!preset) return;
    this.current = cloneMap(preset.map);
    this.loadIntoEditor(this.current);
    this.applyRules(preset.rules ?? {});
    $("map-preset-name").value = preset.name;
    this.status(`已载入预设「${preset.name}」，对局规则也已恢复。`);
  }

  removePreset() {
    const name = $("map-preset-list").value;
    if (!name) return;
    this.store.removePreset(name);
    this.renderPresets();
    this.status("预设已删除。");
  }

  updateSelected(map) {
    const selected = this.editor.findSelected();
    $("map-selected-delete").disabled = !selected || selected.kind === "spawn";
    const radius = selected?.item?.radius;
    $("map-radius").disabled = !selected || selected.kind === "spawn";
    if (Number.isFinite(radius)) {
      $("map-radius").value = radius;
      $("map-radius-value").textContent = Math.round(radius);
    }
    $("map-json").value = this.store.exportJson(map);
  }

  updateRadiusControl() {
    const spike = $("map-tool").value === "spike";
    $("map-radius").min = spike ? 24 : 30;
    $("map-radius").max = spike ? 110 : 360;
    $("map-radius").value = spike ? 48 : 90;
    $("map-radius-value").textContent = $("map-radius").value;
  }

  status(message, error = false, kind = "") {
    const element = $("map-status");
    element.textContent = `${kind ? `${kind}：` : ""}${message}`;
    element.dataset.kind = error ? "error" : "ok";
  }

  dispose() {
    this.editor.dispose();
  }
}
