import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const { document, HTMLElement } = parseHTML("<html><body></body></html>");
HTMLElement.prototype.createEl = function (tag, options = {}) {
  const el = document.createElement(tag);
  if (options.text !== undefined) el.textContent = options.text;
  if (options.type) el.setAttribute("type", options.type);
  if (options.href) el.setAttribute("href", options.href);
  if (options.cls) el.className = options.cls;
  this.append(el);
  return el;
};
HTMLElement.prototype.createDiv = function () {
  return this.createEl("div");
};
HTMLElement.prototype.empty = function () {
  this.innerHTML = "";
};
const id = "notion-note-publisher";
const parent = "11111111-1111-4111-8111-111111111111";
const requests = [];
const commands = new Map();
const notices = [];
const source = "# 标题\n\n![[图片.png]]\n\n- [x] 完成";
let content = source;
let saved = { token: "fixture-token", parent, notes: {} };
const storage = new Map();
const blocks = new Map();
const pages = new Map();
const imageBytes = new Uint8Array([137, 80, 78, 71]).buffer;
const events = new Map();
let modal;
class TFile {
  constructor(name) {
    this.name = this.path = name;
    this.extension = name.split(".").at(-1);
    this.basename = name.replace(/\.[^.]+$/, "");
  }
}
const note = new TFile("笔记.md");
const image = new TFile("图片.png");
class MarkdownView {
  file = note;
  containerEl = document.body.createEl("div");
  contentEl = this.containerEl.createEl("div");
}
const view = new MarkdownView();
class Plugin {
  manifest = { id };
  app = {
    vault: {
      configDir: ".obsidian",
      getMarkdownFiles: () => [note],
      on: (event, handler) => {
        events.set(event, handler);
      },
      read: async () => content,
      readBinary: async () => imageBytes,
      process: async (_file, fn) => {
        content = fn(content);
      },
      adapter: {
        exists: async (path) => storage.has(path),
        mkdir: async (path) => {
          storage.set(path, "folder");
        },
        write: async (path, text) => {
          storage.set(path, text);
        },
        read: async (path) => storage.get(path),
      },
    },
    metadataCache: {
      getFirstLinkpathDest: () => image,
      getFileCache: () => ({ frontmatter: {} }),
      on: () => {},
    },
    workspace: {
      getActiveFile: () => note,
      on: () => {},
      onLayoutReady: (fn) => fn(),
      iterateAllLeaves: (fn) => fn({ view }),
    },
  };
  async loadData() {
    return saved;
  }
  async saveData(value) {
    saved = structuredClone(value);
  }
  addSettingTab() {}
  registerEvent() {}
  register() {}
  addCommand(command) {
    commands.set(command.id, command);
  }
}
class Notice {
  constructor(message) {
    notices.push(message);
  }
  setMessage() {}
  hide() {}
}
class Modal {
  modalEl = document.body.createEl("div");
  contentEl = this.modalEl.createEl("div");
  setTitle(title) {
    this.title = title;
  }
  open() {
    modal = this;
    this.onOpen?.();
  }
  close() {
    this.onClose?.();
    this.modalEl.remove();
    if (modal === this) modal = undefined;
  }
}
const obsidian = {
  Plugin,
  Notice,
  TFile,
  MarkdownView,
  Modal,
  normalizePath: (path) => path,
  PluginSettingTab: class {},
  Setting: class {},
  requestUrl: async (request) => {
    requests.push(request);
    if (request.url.startsWith("https://files.example.com"))
      return { status: 200, arrayBuffer: imageBytes, headers: { "content-type": "image/png" } };
    const path = new URL(request.url).pathname;
    let body;
    if (path.endsWith("/send")) {
      const data = await new Request(request.url, {
        method: "POST",
        headers: { "Content-Type": request.headers["Content-Type"] },
        body: request.body,
      }).formData();
      assert.deepEqual(
        [...new Uint8Array(await data.get("file").arrayBuffer())],
        [137, 80, 78, 71],
      );
      body = { id: path.split("/").at(-2), status: "uploaded" };
    } else if (path === "/v1/file_uploads") body = { id: crypto.randomUUID() };
    else if (path === "/v1/pages" && request.method === "POST") {
      const page = crypto.randomUUID();
      body = {
        id: page,
        url: `https://notion.so/${page}`,
        last_edited_time: "2026-11-05T00:00:00Z",
        in_trash: false,
      };
      pages.set(page, body);
      blocks.set(page, []);
    } else if (path.startsWith("/v1/pages/")) body = pages.get(path.split("/").at(-1));
    else if (path.endsWith("/children")) {
      const parentId = path.split("/").at(-2);
      if (request.method === "PATCH") {
        const children = JSON.parse(request.body).children.map((block) => {
          const result = { ...block, id: crypto.randomUUID(), has_children: false };
          if (result.type === "image")
            result.image = {
              type: "file",
              file: { url: `https://files.example.com/${result.id}` },
              caption: result.image.caption ?? [],
            };
          return result;
        });
        blocks.set(parentId, [...(blocks.get(parentId) ?? []), ...children]);
        body = { results: children, has_more: false, next_cursor: null };
      } else body = { results: blocks.get(parentId) ?? [], has_more: false, next_cursor: null };
    } else if (request.method === "DELETE") {
      const blockId = path.split("/").at(-1);
      for (const [page, children] of blocks)
        blocks.set(
          page,
          children.filter((block) => block.id !== blockId),
        );
      body = {};
    } else throw new Error(`Unexpected request ${request.method} ${path}`);
    return { status: 200, headers: {}, text: JSON.stringify(body) };
  },
};
let opened = 0;
const context = vm.createContext({
  module: { exports: {} },
  require: (name) => {
    assert.equal(name, "obsidian");
    return obsidian;
  },
  document,
  CSSStyleSheet: class { replaceSync() {} },
  HTMLElement,
  SVGElement: document.defaultView.SVGElement,
  MutationObserver: document.defaultView.MutationObserver,
  HTMLPreElement: document.defaultView.HTMLPreElement,
  HTMLSlotElement: document.defaultView.HTMLSlotElement,
  ShadowRoot: document.defaultView.ShadowRoot,
  Node: document.defaultView.Node,
  Element: HTMLElement,
  customElements: document.defaultView.customElements,
  ResizeObserver: class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
  requestAnimationFrame: (fn) => setTimeout(() => fn(Date.now()), 0),
  cancelAnimationFrame: clearTimeout,
  getComputedStyle: () => ({ getPropertyValue: () => "", overflow: "auto" }),
  crypto,
  TextEncoder,
  TextDecoder,
  URL,
  structuredClone,
  setTimeout,
  clearTimeout,
  window: {
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    open: () => {
      opened++;
    },
  },
  console,
});
vm.runInContext(await fs.readFile(new URL("../dist/main.js", import.meta.url), "utf8"), context);
const plugin = new context.module.exports();
await plugin.onload();
const until = async (fn) => {
  const end = Date.now() + 4000;
  while (!fn()) {
    if (Date.now() > end) throw new Error(`Timed out: ${notices.join("; ")}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};
const command = (name) => assert.equal(commands.get(name).checkCallback(false), true);
const click = async (text) => {
  const button = [...modal.contentEl.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  );
  assert.ok(button, `Missing button ${text}`);
  await button.onclick();
};
// First publish associates without modifying Markdown; repeat publish updates the same page.
command("publish-current-note");
await until(() => opened === 1);
const pageId = saved.bindings[note.path].page;
assert.equal(content, source);
assert.equal(Object.keys(saved.notes).length, 0);
assert.equal(
  document.querySelector(".notion-publisher-bar a").getAttribute("href"),
  pages.get(pageId).url,
);
command("publish-current-note");
await click("批准发布本地内容");
await until(() => opened === 2);
assert.equal(pages.size, 1);
assert.equal(saved.bindings[note.path].page, pageId);
assert.equal(blocks.get(pageId).length, 3);
assert.equal(content, source);
// Two remote edits produce independent decisions. Apply immediately changes only one.
const remoteBlocks = blocks.get(pageId);
const heading = remoteBlocks.find((block) => block.type === "heading_1");
heading.heading_1.rich_text = [{ type: "text", text: { content: "Notion edited" } }];
const task = remoteBlocks.find((block) => block.type === "to_do");
task.to_do.rich_text = [{ type: "text", text: { content: "Remote task" } }];
const writeCount = () =>
  requests.filter((request) => !["GET", undefined].includes(request.method)).length;
const beforePullWrites = writeCount();
command("pull-notion-edits");
await until(() => modal?.title?.startsWith("逐处审阅"));
assert.equal(content, source);
assert.ok(saved.bindings[note.path].pending);
const edited = modal.contentEl.querySelector("textarea");
assert.ok(edited, notices.join("; "));
const pierreHost = modal.contentEl.querySelector("[data-pierre-review]");
assert.ok(
  pierreHost?.shadowRoot?.querySelector("pre"),
  "The real Pierre renderer must mount in Shadow DOM",
);
assert.ok(pierreHost.shadowRoot.querySelector("pre").textContent.includes("Notion edited"));
assert.ok(pierreHost.shadowRoot.querySelector("pre").textContent.includes("标题"));
await click("切换上下对比");
assert.ok(
  modal.contentEl
    .querySelector("[data-pierre-review]")
    .shadowRoot.querySelector("pre")
    .textContent.includes("Notion edited"),
);
await click("切换并排对比");
assert.ok(edited.value.includes("Notion edited"));
edited.value = edited.value.replace("Notion edited", "Human edited");
edited.oninput();
modal.close();
await new Promise((resolve) => setTimeout(resolve, 10));
command("pull-notion-edits");
await until(() => modal?.title?.startsWith("逐处审阅"));
assert.ok(modal.contentEl.querySelector("textarea").value.includes("Human edited"));
const requestsBeforeApply = requests.length;
await click("Apply 此处");
assert.equal(
  requests.length,
  requestsBeforeApply,
  "Applying an approved frozen snapshot must not wait on Notion requests",
);
assert.equal(
  modal.contentEl.querySelector("[data-review-queue]")?.querySelectorAll("button").length,
  1,
  "Applied changes must leave the pending queue",
);
assert.ok(content.includes("Human edited"));
assert.ok(content.includes("完成"));
assert.ok(!content.includes("Remote task"));
assert.ok(saved.bindings[note.path].pending, "Other hunks remain pending after one Apply");
assert.ok([...storage.keys()].some((path) => path.includes("backup-")));
modal.close();
await new Promise((resolve) => setTimeout(resolve, 10));
command("pull-notion-edits");
await until(() => modal?.title?.startsWith("逐处审阅"));
assert.ok(modal.contentEl.textContent.includes("已应用 1"));
await click("Reject 此处");
assert.equal(modal.contentEl.querySelector("[data-review-queue]"), null);
assert.ok(modal.contentEl.textContent.includes("待审核队列已清空"));
assert.ok(content.includes("完成"));
assert.equal(saved.bindings[note.path].pending, undefined);
assert.equal(writeCount(), beforePullWrites);
await click("完成审阅");
// Rejecting consumes the remote change; a subsequent pull does not propose it again.
command("pull-notion-edits");
await until(() => modal?.title?.startsWith("逐处审阅"));
assert.ok(modal.contentEl.textContent.includes("没有需要 Apply"));
await click("确认同步基线（不改正文）");
// The Apply action cannot overwrite edits made after capture.
heading.heading_1.rich_text = [{ type: "text", text: { content: "Another remote edit" } }];
command("pull-notion-edits");
await until(() => modal?.title?.startsWith("逐处审阅"));
content += "\nConcurrent local edit";
const applyButton = [...modal.contentEl.querySelectorAll("button")].find((button) =>
  button.textContent.startsWith("Apply"),
);
assert.ok(applyButton);
await applyButton.onclick();
assert.ok(modal.contentEl.textContent.includes("本地笔记已修改"));
assert.ok(content.endsWith("Concurrent local edit"));
modal.close();
await new Promise((resolve) => setTimeout(resolve, 10));
// A crash after the file write but before checkpointing is recovered from its journal.
const pendingPath = saved.bindings[note.path].pending;
const review = JSON.parse(storage.get(pendingPath));
content = review.session.document;
const hunk = review.session.hunks.find((hunk) => hunk.decision.kind === "pending");
const action = { kind: "apply", id: hunk.id, text: "Recovered human change\n\n", at: "now" };
const after =
  content.slice(0, hunk.start) + action.text + content.slice(hunk.start + hunk.before.length);
review.journal = { action, before: content, after };
storage.set(pendingPath, JSON.stringify(review));
content = after;
command("pull-notion-edits");
await until(() => modal?.title?.startsWith("逐处审阅"));
assert.ok(modal.contentEl.textContent.includes("已应用 1"));
assert.equal(content, after);
assert.equal(JSON.parse(storage.get(pendingPath)).journal, undefined);
assert.equal(saved.bindings[note.path].pending, undefined);
modal.close();
// A legacy whole-document snapshot migrates to independent hunks without writing the note.
const legacy = { ...review, local: content };
delete legacy.version;
delete legacy.session;
delete legacy.drafts;
delete legacy.journal;
const legacyPath = ".obsidian/plugins/notion-note-publisher/history/legacy.json";
storage.set(legacyPath, JSON.stringify(legacy));
plugin.settings.bindings[note.path].pending = legacyPath;
command("pull-notion-edits");
await until(() => modal?.title?.startsWith("逐处审阅"));
assert.equal(content, after);
assert.equal(JSON.parse(storage.get(saved.bindings[note.path].pending)).version, 3);
modal.close();
// The rename event keeps the same page association and updates the virtual header.
const oldPath = note.path;
note.path = "Renamed.md";
events.get("rename")(note, oldPath);
await new Promise((resolve) => setTimeout(resolve, 10));
assert.equal(saved.bindings[note.path].page, pageId);
assert.equal(saved.bindings[oldPath], undefined);
console.info(
  "Built-plugin smoke passed: stable page, no Markdown metadata writes, virtual header, semantic hunks, immediate Apply, Reject, saved progress, backup, stale-edit protection, crash recovery, rename.",
);
