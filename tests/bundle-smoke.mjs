import assert from "node:assert/strict";
import fs from "node:fs/promises";
import vm from "node:vm";
import { parseHTML } from "linkedom";

const parent = "11111111-1111-4111-8111-111111111111";
const requests = [];
const commands = new Map();
const notices = [];
const settings = { token: "fixture-token", parent, notes: {} };
const frontmatter = {};
class TFile {
  constructor(name) {
    this.name = name;
    this.path = name;
    this.extension = name.split(".").at(-1);
    this.basename = name.replace(/\.[^.]+$/, "");
  }
}
const note = new TFile("笔记.md");
const image = new TFile("图片.png");
let saved = structuredClone(settings);
let resolveOpen;
const opened = () =>
  new Promise((resolve) => {
    resolveOpen = resolve;
  });
class Plugin {
  app = {
    vault: {
      read: async () => "# 标题\n\n![[图片.png]]\n\n- [x] 完成",
      readBinary: async () => new Uint8Array([137, 80, 78, 71]).buffer,
    },
    metadataCache: { getFirstLinkpathDest: () => image, getFileCache: () => ({ frontmatter }) },
    workspace: { getActiveFile: () => note, on: () => () => {} },
    fileManager: { processFrontMatter: async (_file, callback) => callback(frontmatter) },
  };
  async loadData() {
    return saved;
  }
  async saveData(value) {
    saved = structuredClone(value);
  }
  addSettingTab() {}
  registerEvent() {}
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
const obsidian = {
  Plugin,
  Notice,
  TFile,
  PluginSettingTab: class {},
  Setting: class {},
  requestUrl: async (request) => {
    requests.push(request);
    const path = new URL(request.url).pathname;
    let body = {};
    if (path.endsWith("/send")) {
      const multipart = new Request(request.url, {
        method: "POST",
        headers: { "Content-Type": request.headers["Content-Type"] },
        body: request.body,
      });
      const data = await multipart.formData();
      assert.deepEqual(
        [...new Uint8Array(await data.get("file").arrayBuffer())],
        [137, 80, 78, 71],
      );
      body = { id: path.split("/").at(-2), status: "uploaded" };
    } else if (path === "/v1/file_uploads") body = { id: crypto.randomUUID() };
    else if (path === "/v1/pages" && request.method === "POST")
      body = { id: crypto.randomUUID(), url: "https://notion.so/fixture" };
    else if (path.endsWith("/children"))
      body = {
        results: JSON.parse(request.body).children.map(() => ({ id: crypto.randomUUID() })),
        has_more: false,
        next_cursor: null,
      };
    else if (request.method === "GET") body = { archived: false };
    return { status: 200, headers: {}, text: JSON.stringify(body) };
  },
};
const context = vm.createContext({
  module: { exports: {} },
  require: (name) => {
    assert.equal(name, "obsidian");
    return obsidian;
  },
  document: parseHTML("<html></html>").document,
  crypto,
  TextEncoder,
  TextDecoder,
  URL,
  structuredClone,
  setTimeout,
  clearTimeout,
  window: { open: (url) => resolveOpen(url) },
  console,
});
vm.runInContext(await fs.readFile(new URL("../dist/main.js", import.meta.url), "utf8"), context);
const plugin = new context.module.exports();
await plugin.onload();
for (let i = 0; i < 2; i++) {
  const completion = opened();
  assert.equal(commands.get("publish-current-note").checkCallback(false), true);
  await Promise.race([
    completion,
    new Promise((_, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Publish did not finish: ${notices.join("; ")}`)),
        3000,
      );
      timer.unref();
    }),
  ]);
}
assert.equal(requests.filter((r) => r.url.endsWith("/pages") && r.method === "POST").length, 1);
assert.equal(requests.filter((r) => r.method === "DELETE").length, 1);
assert.equal(Object.keys(saved.notes).length, 1);
assert.equal(typeof frontmatter["notion-publisher-id"], "string");
assert.ok(requests.some((r) => typeof r.body === "string" && r.body.includes("file_upload")));
assert.ok(
  !requests.some((r) => typeof r.body === "string" && r.body.includes("obsidian-upload.invalid")),
);
console.info(
  "Built-plugin smoke check passed: command → image upload → page create → update → old-container cleanup.",
);
