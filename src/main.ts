import { Notice, Plugin, PluginSettingTab, Setting, TFile, requestUrl } from "obsidian";
import { z } from "zod";
import { convert, imageMime } from "./markdown";
import { Notion, pageId, type Transport } from "./notion";
import { mappingSchema, publish } from "./publish";

const settingsSchema = z.object({
  token: z.string().default(""),
  parent: z.string().default(""),
  notes: z.record(z.string(), mappingSchema).default({}),
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

export default class NotionPublisher extends Plugin {
  settings = settingsSchema.parse({});
  private busy = false;

  async onload() {
    this.settings = settingsSchema.parse((await this.loadData()) ?? {});
    this.addSettingTab(new PublisherSettings(this));
    this.addCommand({
      id: "publish-current-note",
      name: "发布当前笔记到 Notion",
      checkCallback: (checking) => {
        if (!this.app.workspace.getActiveFile()) return false;
        if (!checking) void this.publishCurrent();
        return true;
      },
    });
    this.addCommand({
      id: "open-notion-page",
      name: "打开当前笔记的 Notion 页面",
      callback: () => {
        const file = this.app.workspace.getActiveFile();
        const key: unknown = file
          ? this.app.metadataCache.getFileCache(file)?.frontmatter?.["notion-publisher-id"]
          : undefined;
        const note = typeof key === "string" ? this.settings.notes[key] : undefined;
        if (note) window.open(note.url, "_blank");
        else new Notice("此笔记尚未发布。");
      },
    });
    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (file instanceof TFile && file.extension === "md")
          menu.addItem((item) =>
            item
              .setTitle("发布到 Notion")
              .setIcon("upload-cloud")
              .onClick(() => {
                void this.publishFile(file);
              }),
          );
      }),
    );
  }

  save() {
    return this.saveData(this.settings);
  }
  private async publishCurrent() {
    const file = this.app.workspace.getActiveFile();
    if (file) await this.publishFile(file);
  }

  private async publishFile(file: TFile) {
    if (this.busy) {
      new Notice("正在发布，请等待完成。");
      return;
    }
    if (file.extension !== "md") {
      new Notice("请选择 Markdown 笔记。");
      return;
    }
    this.busy = true;
    const notice = new Notice("正在准备发布…", 0);
    try {
      if (!this.settings.token.trim())
        throw new Error("请先在插件设置中填写 Notion Integration Token。");
      const parent = pageId(this.settings.parent);
      let key = "";
      await this.app.fileManager.processFrontMatter(file, (fm) => {
        const existing: unknown = fm["notion-publisher-id"];
        key =
          typeof existing === "string" && z.string().uuid().safeParse(existing).success
            ? existing
            : crypto.randomUUID();
        fm["notion-publisher-id"] = key;
      });
      const api = new Notion(this.settings.token.trim(), transport);
      const blocks = await convert(
        await this.app.vault.read(file),
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
      notice.setMessage("正在写入 Notion…");
      const result = await publish({
        api,
        parent,
        title: file.basename,
        blocks,
        save: async (value) => {
          this.settings.notes[key] = structuredClone(value);
          await this.save();
        },
      });
      new Notice(`发布完成：${file.basename}`);
      window.open(result.url, "_blank");
    } catch (error) {
      new Notice(error instanceof Error ? error.message : "发布失败，请重试。", 12000);
    } finally {
      this.busy = false;
      notice.hide();
    }
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
      text: "每次发布都会新建一张 Notion 子页面，正文和图片直接放在页面中。请将目标父页面连接到你的 Notion Integration。旧页面会保留。",
    });
    new Setting(containerEl)
      .setName("Integration Token")
      .setDesc("仅发送给 api.notion.com；以明文保存在此插件的 data.json 中，请勿提交或共享该文件。")
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
      .setDesc("填写普通 Notion 页面的链接或 ID。笔记将创建为它的子页面。")
      .addText((text) =>
        text.setValue(publisher.settings.parent).onChange(async (value) => {
          publisher.settings.parent = value;
          await publisher.save();
        }),
      );
    new Setting(containerEl).setName("测试连接").addButton((button) =>
      button.setButtonText("测试").onClick(async () => {
        try {
          const api = new Notion(publisher.settings.token.trim(), transport);
          await api.request("GET", `/pages/${pageId(publisher.settings.parent)}`);
          new Notice("连接成功，目标页面可访问。");
        } catch (error) {
          new Notice(error instanceof Error ? error.message : "连接失败。");
        }
      }),
    );
    containerEl.createEl("p", {
      text: "图片支持 ![[image.png]]、![说明](path/image.png) 和引用式图片。单图上限 5 MB。外链图片保留原链接。发布不会将 Notion 页面自动公开到互联网。",
    });
  }
}
