import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

class TestEvent {
  constructor(type, options = {}) {
    this.type = type;
    Object.assign(this, options);
  }

  preventDefault() {
    this.defaultPrevented = true;
  }
}

class TestElement {
  constructor(document, tagName) {
    this.document = document;
    this.tagName = tagName.toUpperCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.listeners = {};
    this.style = { setProperty(name, value) { this[name] = value; } };
    this.className = "";
    this.classList = {
      contains: (name) => this.className.split(/\s+/).includes(name),
      add: (name) => {
        if (!this.classList.contains(name)) this.className = `${this.className} ${name}`.trim();
      },
      remove: (name) => {
        this.className = this.className.split(/\s+/).filter((part) => part !== name).join(" ");
      },
      toggle: (name, enabled) => {
        if (enabled) this.classList.add(name);
        else this.classList.remove(name);
      },
    };
  }

  set value(value) { this._value = String(value); }
  get value() { return this._value || ""; }
  get nextElementSibling() {
    const siblings = this.parentElement.children;
    return siblings[siblings.indexOf(this) + 1] || null;
  }
  set innerHTML(markup) {
    this.children = [];
    for (const match of markup.matchAll(/class="([^"]+)"/g)) {
      const element = new TestElement(this.document, "span");
      element.className = match[1];
      this.append(element);
    }
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
  }

  after(element) {
    const siblings = this.parentElement.children;
    element.parentElement = this.parentElement;
    siblings.splice(siblings.indexOf(this) + 1, 0, element);
  }

  querySelector(selector) {
    return this.querySelectorAll(selector)[0] || null;
  }

  querySelectorAll(selector) {
    const descendants = this.children.flatMap((child) => [child, ...child.querySelectorAll("*")]);
    if (selector === "*") return descendants;
    if (selector.startsWith(".")) return descendants.filter((child) => child.classList.contains(selector.slice(1)));
    if (selector === "label") return descendants.filter((child) => child.tagName === "LABEL");
    if (selector === "button") return descendants.filter((child) => child.tagName === "BUTTON");
    if (selector === "button:not(:disabled), input:not(:disabled)") {
      return descendants.filter((child) => ["BUTTON", "INPUT"].includes(child.tagName) && !child.disabled);
    }
    return [];
  }

  closest(selector) {
    return selector === "button[data-color]" && this.tagName === "BUTTON" && this.dataset.color ? this : null;
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  getAttribute(name) { return this.attributes[name] ?? null; }
  addEventListener(type, listener) { (this.listeners[type] ??= []).push(listener); }
  dispatchEvent(event) {
    event.target ??= this;
    for (const listener of this.listeners[event.type] || []) listener(event);
    if (event.bubbles && this.parentElement) this.parentElement.dispatchEvent(event);
    return !event.defaultPrevented;
  }
  click() { this.dispatchEvent(new TestEvent("click", { bubbles: true })); }
  focus() { this.document.activeElement = this; }
}

const source = await readFile(new URL("../app.js", import.meta.url), "utf8");
const instrumented = source.replace(
  /\ninit\(\);\s*\}\)\(\);\s*$/,
  "\nwindow.colorPickerTest = { initHarmonyColorPicker, applySettingsToControls, syncSettingFromControl, reset: () => { settings = { ...DEFAULT_SETTINGS }; applySettingsToControls(); } };\n})();",
);
assert.notEqual(instrumented, source, "Could not initialize the color picker test harness");

function createApp(userAgent, stored = null, colorInputType = "color") {
  const elements = new Map();
  const controls = [];
  const document = {
    activeElement: null,
    createElement(tagName) { return new TestElement(this, tagName); },
    querySelector(selector) { return elements.get(selector) || null; },
    querySelectorAll(selector) {
      if (selector === "[data-setting]" || selector === 'input[type="color"][data-setting]') return controls;
      return [];
    },
  };
  function element(id, tagName = "div") {
    const result = document.createElement(tagName);
    result.id = id;
    elements.set(`#${id}`, result);
    return result;
  }
  element("saveStatus");
  const backdrop = element("colorPickerBackdrop");
  const dialog = element("colorPickerDialog", "section");
  backdrop.append(dialog);
  dialog.append(element("colorPickerTitle"), element("colorPickerClose", "button"), element("colorPickerPreview"));
  dialog.append(element("colorPickerHex", "input"), element("colorPickerHexHint"), element("colorPickerSwatches"));
  for (const channel of ["Red", "Green", "Blue"]) {
    dialog.append(element(`colorPicker${channel}`, "input"), element(`colorPicker${channel}Output`, "output"));
  }
  dialog.append(element("colorPickerDone", "button"));
  const fields = [
    ["gridFrameColor", "外框"], ["gridCrossColor", "中间十字"], ["gridDiagonalColor", "对角线"],
    ["strokeActiveColor", "当前笔画"], ["guideColor", "范字颜色"], ["traceColor", "描红颜色"],
  ];
  for (const [id, name] of fields) {
    const field = document.createElement("div");
    const label = document.createElement("label");
    label.textContent = name;
    const input = element(id, "input");
    input.type = colorInputType;
    input.dataset.setting = id;
    field.append(label, input);
    controls.push(input);
  }
  const storage = new Map(stored ? [["hanzifun.settings", stored]] : []);
  const localStorage = {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
  };
  const window = { HANZI_STROKES: {} };
  vm.runInNewContext(instrumented, {
    window, document, localStorage, navigator: { userAgent }, location: { protocol: "file:" },
    Event: TestEvent, requestAnimationFrame: () => 1, cancelAnimationFrame: () => {},
  });
  const api = window.colorPickerTest;
  api.applySettingsToControls();
  for (const control of controls) {
    control.addEventListener("input", () => api.syncSettingFromControl(control));
  }
  api.initHarmonyColorPicker();
  return { api, controls, document, elements, storage };
}

for (const ua of ["OpenHarmony 5.0", "HarmonyOS 4", "Android 10 ArkWeb/4.1"]) {
  const { controls } = createApp(ua);
  assert.equal(controls.filter((input) => input.hidden && input.nextElementSibling).length, 6);
}
for (const ua of ["Android 13 Chrome/114", "Linux Chrome/114"]) {
  const { controls } = createApp(ua);
  assert.equal(controls.filter((input) => input.hidden || input.nextElementSibling).length, 0);
}
assert.equal(createApp("Android 13 Chrome/114", null, "text").controls.filter((input) => input.hidden).length, 6);

const app = createApp("OpenHarmony 5.0 ArkWeb/4.1", null, "text");
const { controls, document, elements, storage } = app;
const field = controls[0];
const trigger = field.nextElementSibling;
const hex = elements.get("#colorPickerHex");
const swatches = elements.get("#colorPickerSwatches");
trigger.click();
assert.equal(elements.get("#colorPickerTitle").textContent, "选择外框颜色");
assert.equal(document.activeElement, elements.get("#colorPickerClose"));
assert.equal(field.parentElement.querySelector("label").htmlFor, trigger.id);
assert.equal(trigger.getAttribute("aria-expanded"), "true");
assert.equal(hex.value, "#AEBAC2");

swatches.children.find((button) => button.dataset.color === "#e53935").click();
assert.equal(field.value, "#e53935");
assert.equal(hex.value, "#E53935");
assert.equal(elements.get("#colorPickerRed").value, "229");
assert.equal(swatches.children.find((button) => button.dataset.color === "#e53935").getAttribute("aria-pressed"), "true");
assert.equal(JSON.parse(storage.get("hanzifun.settings")).gridFrameColor, "#e53935");

hex.value = "#12zzzz";
hex.dispatchEvent(new TestEvent("input"));
assert.equal(hex.getAttribute("aria-invalid"), "true");
assert.match(elements.get("#colorPickerHexHint").textContent, /颜色无效/);
assert.equal(field.value, "#e53935");

hex.value = "0f10ff";
hex.dispatchEvent(new TestEvent("input"));
assert.equal(field.value, "#0f10ff");
assert.equal(hex.getAttribute("aria-invalid"), "false");
const green = elements.get("#colorPickerGreen");
green.value = 0;
green.dispatchEvent(new TestEvent("input"));
assert.equal(field.value, "#0f00ff");
assert.equal(trigger.querySelector(".color-picker-value").textContent, "#0F00FF");

const dialog = elements.get("#colorPickerDialog");
elements.get("#colorPickerClose").focus();
dialog.dispatchEvent(new TestEvent("keydown", { key: "Tab", shiftKey: true }));
assert.equal(document.activeElement, elements.get("#colorPickerDone"));
dialog.dispatchEvent(new TestEvent("keydown", { key: "Tab" }));
assert.equal(document.activeElement, elements.get("#colorPickerClose"));
dialog.dispatchEvent(new TestEvent("keydown", { key: "Escape" }));
assert.equal(elements.get("#colorPickerBackdrop").hidden, true);
assert.equal(document.activeElement, trigger);
assert.equal(trigger.getAttribute("aria-expanded"), "false");
const reloaded = createApp("HarmonyOS 4", storage.get("hanzifun.settings"));
assert.equal(reloaded.controls[0].nextElementSibling.querySelector(".color-picker-value").textContent, "#0F00FF");
app.api.reset();
assert.equal(trigger.querySelector(".color-picker-value").textContent, "#AEBAC2");

console.log("HarmonyOS color picker check passed.");
