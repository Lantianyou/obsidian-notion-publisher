import {
  MarkdownView,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  normalizePath,
  requestUrl,
} from "obsidian";
import { ReviewDiff } from "./diff-view";
import { z } from "zod";
import { convert, imageMime } from "./markdown";
import { Notion, pageId, type Transport } from "./notion";
import { mappingSchema, publish, updatePage } from "./publish";
import { frontmatter, requireUnchanged, toMarkdown, publishedMarkdown } from "./pull";
import { createSession, decide, complete, type ReviewAction } from "./review-model";
import {
  assertUnique,
  bindingSchema,
  moveBindings,
  reviewSchema,
  revision,
  type Binding,
  type Review,
} from "./sync-state";

const settingsSchema = z.object({
  token: z.string().default(""),
  parent: z.string().default(""),
  notes: z.record(z.string(), mappingSchema).default({}),
  bindings: z.record(z.string(), bindingSchema).default({}),
});
const transport: Transport = async (request) => {
  const response = await requestUrl({ ...request, throw: false });
  let body: unknown;
  try {
    body = JSON.parse(response.text);
  } catch {
    body = null;
  }
  return { status: response.status, headers: response.headers, body };
};
const sha = async (data: ArrayBuffer) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

export default class NotionPublisher extends Plugin {
  settings = settingsSchema.parse({});
  private busy = false;
  private activeReview: PullReview | null = null;
  private bars = new Map<MarkdownView, HTMLElement>();
  get storage() {
    return normalizePath(`${this.app.vault.configDir}/plugins/${this.manifest.id}`);
  }

  async onload() {
    this.settings = settingsSchema.parse((await this.loadData()) ?? {});
    this.addSettingTab(new PublisherSettings(this));
    for (const [id, name, run] of [
      [
        "publish-current-note",
        "发布当前笔记到 Notion（更新关联页面）",
        (file: TFile) => this.publishFile(file),
      ],
      ["pull-notion-edits", "拉取 Notion 修改并审阅", (file: TFile) => this.pullFile(file)],
      ["bind-notion-page", "关联当前笔记到 Notion 页面", (file: TFile) => this.bindModal(file)],
      ["open-notion-page", "打开当前笔记的 Notion 页面", (file: TFile) => this.openPage(file)],
    ] satisfies [string, string, (file: TFile) => unknown][]) {
      this.addCommand({
        id,
        name,
        checkCallback: (checking) => {
          const file = this.app.workspace.getActiveFile();
          if (!file || file.extension !== "md") return false;
          if (!checking) void run(file);
          return true;
        },
      });
    }
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile) || file.extension !== "md") return;
        menu.addItem((item) =>
          item
            .setTitle("发布到 Notion")
            .setIcon("upload-cloud")
            .onClick(() => {
              void this.publishFile(file);
            }),
        );
        menu.addItem((item) =>
          item
            .setTitle("拉取 Notion 修改并审阅")
            .setIcon("download-cloud")
            .onClick(() => {
              void this.pullFile(file);
            }),
        );
      }),
    );
    this.registerEvent(this.app.workspace.on("layout-change", () => this.refreshBars()));
    this.registerEvent(this.app.workspace.on("file-open", () => this.refreshBars()));
    this.registerEvent(
      this.app.metadataCache.on("resolved", () => {
        void this.migrate();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (_file, oldPath) => {
        moveBindings(this.settings.bindings, oldPath, _file.path);
        void this.save().then(() => this.refreshBars());
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        for (const path of Object.keys(this.settings.bindings))
          if (path === file.path || path.startsWith(`${file.path}/`))
            delete this.settings.bindings[path];
        void this.save().then(() => this.refreshBars());
      }),
    );
    this.app.workspace.onLayoutReady(() => {
      void this.migrate();
    });
    this.register(() => {
      this.activeReview?.close();
      for (const bar of this.bars.values()) bar.remove();
      this.bars.clear();
    });
  }

  save() {
    return this.saveData(this.settings);
  }
  private api() {
    if (!this.settings.token.trim())
      throw new Error("请先在插件设置中填写 Notion Integration Token。");
    return new Notion(this.settings.token.trim(), transport);
  }
  private async migrate() {
    let changed = false;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (this.settings.bindings[file.path]) continue;
      const key: unknown =
        this.app.metadataCache.getFileCache(file)?.frontmatter?.["notion-publisher-id"];
      const mapping = typeof key === "string" ? this.settings.notes[key] : undefined;
      if (!mapping) continue;
      if (Object.values(this.settings.bindings).some((value) => value.page === mapping.page))
        continue;
      this.settings.bindings[file.path] = { ...mapping };
      changed = true;
    }
    if (changed) await this.save();
    this.refreshBars();
  }
  private binding(file: TFile) {
    return this.settings.bindings[file.path];
  }
  private openPage(file: TFile) {
    const binding = this.binding(file);
    if (binding) window.open(binding.url, "_blank");
    else new Notice("请先关联 Notion 页面。");
  }
  private refreshBars() {
    const live = new Set<MarkdownView>();
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (!(leaf.view instanceof MarkdownView)) return;
      const view = leaf.view;
      live.add(view);
      this.bars.get(view)?.remove();
      this.bars.delete(view);
      const file = view.file;
      if (!file) return;
      const binding = this.binding(file);
      const bar = document.createElement("div");
      bar.className = "notion-publisher-bar";
      bar.style.cssText =
        "display:flex;align-items:center;gap:12px;flex-wrap:wrap;padding:8px 16px;border-bottom:1px solid var(--background-modifier-border);font-size:var(--font-ui-small);flex-shrink:0";
      if (binding) {
        const link = bar.createEl("a", { text: "↗ Notion · " + file.basename, href: binding.url });
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.title = binding.url;
        bar.createEl("button", { text: binding.pending ? "继续审阅" : "拉取修改" }).onclick =
          () => {
            void this.pullFile(file);
          };
      } else
        bar.createEl("button", { text: "关联 Notion 页面" }).onclick = () => this.bindModal(file);
      view.containerEl.insertBefore(bar, view.contentEl);
      this.bars.set(view, bar);
    });
    for (const [view, bar] of this.bars)
      if (!live.has(view)) {
        bar.remove();
        this.bars.delete(view);
      }
  }

  private bindModal(file: TFile) {
    const modal = new Modal(this.app);
    modal.setTitle("关联 Notion 页面");
    modal.contentEl.createEl("p", {
      text: "一个笔记对应一个 Notion 页面。关联仅保存在插件数据中，不会修改 Markdown。",
    });
    const input = modal.contentEl.createEl("input", {
      type: "text",
      placeholder: "Notion 页面链接",
    });
    input.style.width = "100%";
    input.value = this.binding(file)?.url ?? "";
    const button = modal.contentEl.createEl("button", { text: "验证并关联" });
    button.onclick = async () => {
      if (this.busy) {
        new Notice("请等待当前操作完成。");
        return;
      }
      this.busy = true;
      button.disabled = true;
      try {
        const id = pageId(input.value);
        assertUnique(this.settings.bindings, file.path, id);
        const page = await this.api().retrievePage(id);
        if (page.in_trash) throw new Error("该 Notion 页面已在回收站中。");
        const existing = this.binding(file);
        if (existing && existing.page !== id)
          throw new Error("此笔记已有对应页面；为保持一对一关系，请继续使用原页面。");
        this.settings.bindings[file.path] = existing ?? { page: id, url: page.url };
        await this.save();
        this.refreshBars();
        modal.close();
        new Notice("关联成功，Markdown 未修改。");
      } catch (error) {
        this.report(error);
      } finally {
        this.busy = false;
        button.disabled = false;
      }
    };
    modal.open();
  }
  private report(error: unknown) {
    new Notice(error instanceof Error ? error.message : "操作失败，请重试。", 12000);
  }
  private async writeJson(name: string, value: unknown) {
    const folder = `${this.storage}/history`;
    if (!(await this.app.vault.adapter.exists(folder))) await this.app.vault.adapter.mkdir(folder);
    const path = `${folder}/${name}.json`;
    await this.app.vault.adapter.write(path, JSON.stringify(value));
    return path;
  }

  private async prepareLocal(file: TFile, local: string) {
    const candidates = new Map<string, string>();
    const imagePaths = new Map<string, string>();
    // Reuse identical local images so a pull does not replace Obsidian embeds with temporary URLs.
    const projectedBlocks = await convert(
      local,
      async (link) => {
        const target = this.app.metadataCache.getFirstLinkpathDest(link, file.path);
        if (!target) throw new Error(`找不到图片：${link}`);
        const data = await this.app.vault.readBinary(target);
        candidates.set(await sha(data), target.path);
        return { path: target.path, name: target.name, mime: imageMime(target.extension), data };
      },
      async (image) => {
        const id = crypto.randomUUID();
        imagePaths.set(id, image.path);
        return id;
      },
    );
    return { candidates, projection: await publishedMarkdown(projectedBlocks, imagePaths) };
  }

  private async capture(file: TFile, binding: Binding): Promise<Review> {
    const local = await this.app.vault.read(file);
    const api = this.api();
    const page = await api.retrievePage(binding.page);
    if (page.in_trash) throw new Error("Notion 页面已在回收站中。");
    const blocks = await api.tree(binding.page);
    const stamp = crypto.randomUUID();
    const images: Review["images"] = [];
    const { candidates, projection } = await this.prepareLocal(file, local);
    const remote = await toMarkdown(blocks, async (block, url, internal) => {
      if (!internal) return `![](<${url.replaceAll(">", "%3E")}>)`;
      const response = await requestUrl({ url, method: "GET", throw: false });
      if (response.status !== 200) throw new Error(`Notion 图片下载失败：HTTP ${response.status}`);
      const hash = await sha(response.arrayBuffer);
      const existing = candidates.get(hash);
      if (existing) return `![[${existing}]]`;
      const mime = Object.entries(response.headers)
        .find(([key]) => key.toLowerCase() === "content-type")?.[1]
        ?.split(";")[0];
      const ext = {
        "image/png": "png",
        "image/jpeg": "jpg",
        "image/gif": "gif",
        "image/webp": "webp",
        "image/svg+xml": "svg",
        "image/heic": "heic",
      } satisfies Record<string, string>;
      const extension = z.record(z.string(), z.string()).parse(ext)[mime ?? ""];
      if (!extension) throw new Error(`不支持的 Notion 图片类型：${mime ?? "未知"}`);
      const target = `Notion attachments/${binding.page}/${block.id}-${hash.slice(0, 12)}.${extension}`;
      const stageFolder = `${this.storage}/staged`;
      if (!(await this.app.vault.adapter.exists(stageFolder)))
        await this.app.vault.adapter.mkdir(stageFolder);
      const staged = `${stageFolder}/${hash}.${extension}`;
      if (!(await this.app.vault.adapter.exists(staged)))
        await this.app.vault.adapter.writeBinary(staged, response.arrayBuffer);
      images.push({ staged, target });
      return `![[${target}]]`;
    });
    if (revision(await api.tree(binding.page)) !== revision(blocks))
      throw new Error("拉取期间 Notion 内容发生变化，请重新拉取。");
    requireUnchanged(await this.app.vault.read(file), local);
    const review: Review = {
      page: binding.page,
      capturedAt: new Date().toISOString(),
      local,
      remote,
      revision: revision(blocks),
      version: 3,
      session: createSession({
        local,
        remote,
        projection,
        ...(binding.baseline ? { baseline: binding.baseline } : {}),
      }),
      drafts: {},
      images,
    };
    binding.pending = await this.writeJson(stamp, review);
    await this.save();
    this.refreshBars();
    return review;
  }

  async pullFile(file: TFile) {
    if (this.activeReview) {
      new Notice("已有审阅窗口，请先完成或关闭。");
      return;
    }
    if (this.busy) {
      new Notice("请等待当前操作完成。");
      return;
    }
    const binding = this.binding(file);
    if (!binding) {
      this.bindModal(file);
      return;
    }
    this.busy = true;
    const notice = new Notice("正在读取 Notion 页面与图片…", 0);
    try {
      let review: Review;
      if (binding.pending) {
        const parsed = reviewSchema.safeParse(
          JSON.parse(await this.app.vault.adapter.read(binding.pending)),
        );
        if (parsed.success) {
          review = parsed.data;
          const current = await this.app.vault.read(file);
          const recoverable =
            !review.journal ||
            current === review.journal.before ||
            current === review.journal.after;
          if (recoverable) await this.recover(binding, review, current);
          if (!recoverable || current !== review.session.document) {
            delete binding.pending;
            review = await this.capture(file, binding);
            new Notice("本地笔记已有编辑，已保留原文并重新生成逐处差异。");
          }
        } else {
          const legacy = reviewSchema
            .omit({ version: true, session: true, drafts: true, journal: true })
            .safeParse(JSON.parse(await this.app.vault.adapter.read(binding.pending)));
          if (
            legacy.success &&
            legacy.data.page === binding.page &&
            legacy.data.local === (await this.app.vault.read(file)) &&
            legacy.data.revision === revision(await this.api().tree(binding.page))
          ) {
            review = {
              ...legacy.data,
              version: 3,
              session: createSession({
                local: legacy.data.local,
                remote: legacy.data.remote,
                projection: (await this.prepareLocal(file, legacy.data.local)).projection,
                ...(binding.baseline ? { baseline: binding.baseline } : {}),
              }),
              drafts: {},
            };
            binding.pending = await this.writeJson(crypto.randomUUID(), review);
            await this.save();
          } else {
            delete binding.pending;
            review = await this.capture(file, binding);
          }
        }
      } else review = await this.capture(file, binding);
      if (review.session.hunks.length && complete(review.session))
        await this.finishReview(file, binding, review);
      this.activeReview = new PullReview(this, file, binding, review);
      this.activeReview.open();
    } catch (error) {
      this.report(error);
    } finally {
      this.busy = false;
      notice.hide();
    }
  }

  reviewClosed() {
    this.activeReview = null;
  }
  async saveDraft(binding: Binding, review: Review) {
    if (binding.pending)
      await this.app.vault.adapter.write(binding.pending, JSON.stringify(review));
  }
  private async recover(binding: Binding, review: Review, current: string) {
    const journal = review.journal;
    if (!journal) return;
    if (current === journal.after) review.session = decide(review.session, journal.action);
    else if (current !== journal.before)
      throw new Error("上次 Apply 后笔记又有修改，请结束旧审阅并重新拉取；已应用的内容会保留。");
    delete review.journal;
    await this.saveDraft(binding, review);
  }

  async decideHunk(file: TFile, binding: Binding, review: Review, action: ReviewAction) {
    if (this.busy) throw new Error("请等待当前操作完成。");
    this.busy = true;
    try {
      if (this.binding(file) !== binding || binding.page !== review.page)
        throw new Error("页面关联已变化，请重新拉取。");
      requireUnchanged(await this.app.vault.read(file), review.session.document);
      const next = decide(review.session, action);
      if (action.kind === "apply") {
        if (frontmatter(next.document) !== frontmatter(review.local))
          throw new Error("此处修改不能改变本地 YAML frontmatter。");
        review.journal = { action, before: review.session.document, after: next.document };
        await this.saveDraft(binding, review);
        await this.writeJson(`backup-${crypto.randomUUID()}`, {
          path: file.path,
          before: review.session.document,
          after: next.document,
          action,
          approvedAt: action.at,
        });
        for (const image of review.images) {
          if (!next.document.includes(`![[${image.target}]]`)) continue;
          const folder = image.target.slice(0, image.target.lastIndexOf("/"));
          if (!(await this.app.vault.adapter.exists(folder)))
            await this.app.vault.createFolder(folder);
          if (!(await this.app.vault.adapter.exists(image.target)))
            await this.app.vault.createBinary(
              image.target,
              await this.app.vault.adapter.readBinary(image.staged),
            );
        }
        await this.app.vault.process(file, (current) => {
          requireUnchanged(current, review.session.document);
          return next.document;
        });
      }
      review.session = next;
      delete review.journal;
      await this.saveDraft(binding, review);
      if (complete(next)) await this.finishReview(file, binding, review);
    } finally {
      this.busy = false;
    }
  }
  async finishReview(file: TFile, binding: Binding, review: Review) {
    if (!complete(review.session)) throw new Error("还有未处理的修改。");
    requireUnchanged(await this.app.vault.read(file), review.session.document);
    binding.baseline = {
      local: review.session.document,
      remote: review.remote,
      revision: review.revision,
    };
    delete binding.pending;
    await this.save();
    this.refreshBars();
  }
  async discard(binding: Binding) {
    delete binding.pending;
    await this.save();
    this.refreshBars();
  }

  private async publishFile(file: TFile) {
    if (this.busy) {
      new Notice("请等待当前操作完成。");
      return;
    }
    const binding = this.binding(file);
    if (binding) {
      const modal = new Modal(this.app);
      modal.setTitle("更新关联的 Notion 页面");
      modal.contentEl.createEl("p", {
        text: "将使用本地正文更新同一个 Notion 页面，页面链接保持不变。若 Notion 上有尚未合并的编辑，请先拉取并审阅。",
      });
      modal.contentEl.createEl("button", { text: "拉取并审阅" }).onclick = () => {
        modal.close();
        void this.pullFile(file);
      };
      modal.contentEl.createEl("button", { text: "批准发布本地内容" }).onclick = () => {
        modal.close();
        void this.performPublish(file, binding);
      };
      modal.open();
    } else await this.performPublish(file, undefined);
  }
  private async performPublish(file: TFile, binding: Binding | undefined) {
    if (this.busy) {
      new Notice("请等待当前操作完成。");
      return;
    }
    this.busy = true;
    const notice = new Notice("正在准备发布…", 0);
    try {
      const api = this.api();
      const source = await this.app.vault.read(file);
      if (binding?.pending) throw new Error("请先完成当前逐处审阅，再发布到 Notion。");
      const previous = binding ? await api.tree(binding.page) : [];
      if (binding && (!binding.baseline || binding.baseline.revision !== revision(previous)))
        throw new Error("请先逐处审阅 Notion 修改并完成基线对齐，再发布到关联页面。");
      const blocks = await convert(
        source,
        async (link) => {
          const image = this.app.metadataCache.getFirstLinkpathDest(link, file.path);
          if (!image) throw new Error(`找不到图片：${link}`);
          return {
            path: image.path,
            name: image.name,
            mime: imageMime(image.extension),
            data: await this.app.vault.readBinary(image),
          };
        },
        async (image) => {
          notice.setMessage(`正在上传：${image.name}`);
          return api.upload(image.name, image.mime, image.data);
        },
      );
      requireUnchanged(await this.app.vault.read(file), source);
      notice.setMessage("正在写入 Notion…");
      const save = async (value: z.infer<typeof mappingSchema>) => {
        assertUnique(this.settings.bindings, file.path, value.page);
        this.settings.bindings[file.path] = { ...value };
        await this.save();
      };
      const result = binding
        ? await updatePage({ api, mapping: binding, blocks, expectedRevision: revision(previous) })
        : await publish({
            api,
            parent: pageId(this.settings.parent),
            title: file.basename,
            blocks,
            save,
          });
      const current = this.settings.bindings[file.path];
      if (!current) throw new Error("页面关联保存失败。");
      // Read the published representation as the baseline without changing the local note.
      const review = await this.capture(file, current);
      current.baseline = { local: source, remote: review.remote, revision: review.revision };
      delete current.pending;
      await this.save();
      this.refreshBars();
      new Notice(`发布完成：${file.basename}`);
      window.open(result.url, "_blank");
    } catch (error) {
      this.report(error);
    } finally {
      this.busy = false;
      notice.hide();
    }
  }
}

class PullReview extends Modal {
  private diffView = new ReviewDiff();
  private selected = 0;
  private submitting = false;
  private ended = false;
  constructor(
    private publisher: NotionPublisher,
    private file: TFile,
    private binding: Binding,
    private review: Review,
  ) {
    super(publisher.app);
  }
  onOpen() {
    this.setTitle("逐处审阅 Notion 修改 · " + this.file.basename);
    this.modalEl.style.width = "min(1100px, 95vw)";
    this.selected = Math.max(
      0,
      this.review.session.hunks.findIndex((hunk) => hunk.decision.kind === "pending"),
    );
    this.render();
  }
  private render() {
    this.diffView.cleanUp();
    const el = this.contentEl;
    el.empty();
    const hunks = this.review.session.hunks;
    const pending = hunks.filter((hunk) => hunk.decision.kind === "pending").length;
    el.createEl("p", {
      text: `每次 Apply 立即写入原笔记。Reject 保留本地；关闭窗口后可继续。已应用 ${hunks.filter((hunk) => hunk.decision.kind === "applied").length} · 已拒绝 ${hunks.filter((hunk) => hunk.decision.kind === "rejected").length} · 待处理 ${pending}`,
    });
    el.createEl("p", {
      text: `正在审阅 ${new Date(this.review.capturedAt).toLocaleString()} 拉取的快照；重新拉取可查看 Notion 的后续修改。`,
    });
    el.createEl("p", {
      text: this.binding.baseline
        ? "仅审阅 Notion 相对上次基线的新修改；同一内容单元的两端修改显示为冲突。"
        : "首次对齐：没有共同基线，逐处比较本地和 Notion。缩进和空行等格式差异已排除。",
    });
    const processed = hunks.filter((hunk) => hunk.decision.kind !== "pending");
    if (processed.length) {
      const history = el.createEl("details");
      history.createEl("summary", { text: `已处理记录（${processed.length}）` });
      for (const hunk of processed)
        history.createEl("div", {
          text: `${hunk.decision.kind === "applied" ? "已 Apply" : "已 Reject"} · ${hunk.section}`,
        });
    }
    if (hunks.length && !pending) {
      el.createEl("p", { text: "全部修改已处理，待审核队列已清空。" });
      el.createEl("button", { text: "完成审阅" }).onclick = () => this.close();
      return;
    }
    if (!hunks.length) {
      el.createEl("p", { text: "没有需要 Apply 的内容差异。" });
      el.createEl("button", { text: "确认同步基线（不改正文）" }).onclick = async () => {
        try {
          await this.publisher.finishReview(this.file, this.binding, this.review);
          this.ended = true;
          this.close();
        } catch (error) {
          new Notice(String(error));
        }
      };
      return;
    }
    const layout = el.createDiv();
    layout.style.cssText = "display:grid;grid-template-columns:200px minmax(0,1fr);gap:16px";
    const nav = layout.createDiv();
    nav.setAttribute("data-review-queue", "");
    const queue = hunks
      .map((hunk, index) => ({ hunk, index }))
      .filter(({ hunk }) => hunk.decision.kind === "pending");
    const position = queue.findIndex((item) => item.index === this.selected);
    nav.style.cssText = "max-height:60vh;overflow:auto;display:flex;flex-direction:column;gap:6px";
    const names = { pending: "待处理", applied: "已 Apply", rejected: "已 Reject" };
    for (const [ordinal, { hunk, index }] of queue.entries()) {
      const button = nav.createEl("button", {
        text: `${ordinal + 1}. ${hunk.kind === "conflict" ? "冲突 · " : ""}${hunk.section.slice(0, 28)} · ${names[hunk.decision.kind]}`,
      });
      button.style.cssText = `text-align:left;white-space:normal;height:auto;padding:8px;${index === this.selected ? "border-color:var(--interactive-accent)" : ""}`;
      button.disabled = this.submitting;
      button.onclick = () => {
        this.selected = index;
        this.render();
      };
    }
    const pane = layout.createDiv();
    const hunk = hunks[this.selected];
    if (!hunk) return;
    const line = this.review.session.document.slice(0, hunk.start).split("\n").length;
    pane.createEl("h3", {
      text: `${position + 1} / ${pending} 待处理 · ${hunk.section} · 第 ${line} 行`,
    });
    if (hunk.kind === "conflict")
      pane.createEl("p", {
        text: "冲突：本地与 Notion 修改了同一内容单元。检查基线和当前原文，再编辑下面的处理结果。",
        cls: "mod-warning",
      });
    if (hunk.base !== undefined) {
      const base = pane.createEl("details");
      base.createEl("summary", { text: "上次 Notion 基线" });
      base.createEl("pre", { text: hunk.base }).style.cssText =
        "white-space:pre-wrap;max-height:20vh;overflow:auto";
    }
    const diff = pane.createDiv();
    this.diffView.render(diff, hunk.before, hunk.proposed);
    pane.createEl("h4", { text: "此处 Apply 的内容（可编辑）" });
    const editor = pane.createEl("textarea");
    editor.setAttribute("aria-label", "此处修改");
    editor.style.cssText =
      "width:100%;height:22vh;font-family:var(--font-monospace);resize:vertical";
    editor.value =
      hunk.decision.kind === "applied"
        ? hunk.decision.text
        : (this.review.drafts[hunk.id] ?? hunk.proposed);
    editor.disabled = hunk.decision.kind !== "pending" || this.submitting;
    editor.oninput = () => {
      this.review.drafts[hunk.id] = editor.value;
    };
    const controls = pane.createDiv();
    controls.style.cssText = "display:flex;gap:8px;flex-wrap:wrap;margin-top:12px";
    const errorEl = pane.createEl("p");
    errorEl.style.color = "var(--text-error)";
    const act = async (kind: "apply" | "reject") => {
      if (this.submitting) return;
      this.submitting = true;
      for (const control of el.querySelectorAll<HTMLButtonElement | HTMLTextAreaElement>(
        "button, textarea",
      ))
        control.disabled = true;
      errorEl.style.color = "var(--text-muted)";
      errorEl.textContent = "正在保存此处修改…";
      try {
        const action: ReviewAction =
          kind === "apply"
            ? { kind, id: hunk.id, text: editor.value, at: new Date().toISOString() }
            : { kind, id: hunk.id, at: new Date().toISOString() };
        await this.publisher.decideHunk(this.file, this.binding, this.review, action);
        const remaining = this.review.session.hunks
          .map((item, index) => ({ item, index }))
          .filter(({ item }) => item.decision.kind === "pending");
        const next =
          remaining.find(({ index }) => index > this.selected)?.index ?? remaining[0]?.index ?? -1;
        if (next >= 0) this.selected = next;
        else this.ended = true;
        this.submitting = false;
        this.render();
      } catch (error) {
        this.submitting = false;
        this.render();
        this.contentEl.createEl("p", {
          text: error instanceof Error ? error.message : "操作失败",
          cls: "mod-warning",
        });
      }
    };
    if (hunk.decision.kind === "pending") {
      const apply = controls.createEl("button", {
        text: hunk.kind === "conflict" ? "Apply 冲突处理结果" : "Apply 此处",
        cls: "mod-cta",
      });
      const reject = controls.createEl("button", { text: "Reject 此处" });
      apply.disabled = reject.disabled = this.submitting;
      apply.onclick = () => act("apply");
      reject.onclick = () => act("reject");
    } else controls.createEl("span", { text: names[hunk.decision.kind] });
    const previous = controls.createEl("button", { text: "上一处" });
    previous.disabled = position <= 0 || this.submitting;
    previous.onclick = () => {
      this.selected = queue[position - 1]?.index ?? this.selected;
      this.render();
    };
    const next = controls.createEl("button", { text: "下一处" });
    next.disabled = position >= queue.length - 1 || this.submitting;
    next.onclick = () => {
      this.selected = queue[position + 1]?.index ?? this.selected;
      this.render();
    };
    if (!pending) controls.createEl("button", { text: "完成审阅" }).onclick = () => this.close();
    const footer = el.createDiv();
    footer.style.marginTop = "16px";
    const refresh = footer.createEl("button", { text: "重新拉取（保留已 Apply 的修改）" });
    refresh.disabled = this.submitting;
    refresh.onclick = async () => {
      try {
        await this.publisher.discard(this.binding);
        this.ended = true;
        this.close();
        void this.publisher.pullFile(this.file);
      } catch (error) {
        errorEl.textContent = String(error);
      }
    };
  }
  onClose() {
    this.diffView.cleanUp();
    this.publisher.reviewClosed();
    if (!this.ended && !this.submitting)
      void this.publisher.saveDraft(this.binding, this.review).catch((error) => {
        new Notice(String(error));
      });
  }
}

class PublisherSettings extends PluginSettingTab {
  constructor(private readonly publisher: NotionPublisher) {
    super(publisher.app, publisher);
  }
  display() {
    const { containerEl, publisher } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Notion Note Publisher" });
    containerEl.createEl("p", {
      text: "一篇笔记关联一个 Notion 页面，再次发布更新同一页面。关联和顶部链接由插件提供，不写入 Markdown；拉取修改必须人工批准后才能写回。",
    });
    new Setting(containerEl)
      .setName("Integration Token")
      .setDesc("仅发送给 api.notion.com；以明文保存在插件 data.json 中，请勿提交或共享该文件。")
      .addText((text) => {
        text.inputEl.type = "password";
        text
          .setPlaceholder("ntn_…")
          .setValue(publisher.settings.token)
          .onChange(async (value) => {
            publisher.settings.token = value;
            await publisher.save();
          });
      });
    new Setting(containerEl)
      .setName("父页面")
      .setDesc("首次发布未关联笔记时，在此页面下新建对应页面。")
      .addText((text) =>
        text.setValue(publisher.settings.parent).onChange(async (value) => {
          publisher.settings.parent = value;
          await publisher.save();
        }),
      );
    new Setting(containerEl).setName("测试连接").addButton((button) =>
      button.setButtonText("测试").onClick(async () => {
        try {
          await new Notion(publisher.settings.token.trim(), transport).retrievePage(
            pageId(publisher.settings.parent),
          );
          new Notice("连接成功。");
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "连接失败。");
        }
      }),
    );
    containerEl.createEl("p", {
      text: "拉取快照、审阅草稿和写回前备份保存在插件 history 目录。Notion 图片优先复用相同的本地图片，新图片在批准后保存到 Notion attachments。旧版 frontmatter 关联可自动迁移；已有 Markdown 不会因此修改。",
    });
  }
}
