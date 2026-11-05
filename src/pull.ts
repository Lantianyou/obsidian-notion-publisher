import type { Block } from "./notion";
import { z } from "zod";

export const remoteBlockSchema = z
  .object({
    id: z.string().uuid(),
    type: z.string(),
    has_children: z.boolean(),
  })
  .passthrough();
export type RemoteBlock = z.infer<typeof remoteBlockSchema> & { children: RemoteBlock[] };
const textSchema = z.array(
  z.object({
    plain_text: z.string().optional(),
    text: z
      .object({ content: z.string(), link: z.object({ url: z.string() }).nullable().optional() })
      .optional(),
    href: z.string().nullable().optional(),
    annotations: z
      .object({
        bold: z.boolean().optional(),
        italic: z.boolean().optional(),
        strikethrough: z.boolean().optional(),
        code: z.boolean().optional(),
        underline: z.boolean().optional(),
      })
      .optional(),
  }),
);
function escape(value: string) {
  return value.replace(/([\\`*_[\]<>])/g, "\\$1");
}
function rich(value: unknown, plain = false): string {
  return textSchema
    .parse(value)
    .map((item) => {
      const raw = item.plain_text ?? item.text?.content ?? "";
      if (plain) return raw;
      let text = escape(raw);
      const a = item.annotations;
      if (a?.code) {
        const fence = "`".repeat(
          Math.max(1, ...[...raw.matchAll(/`+/g)].map((m) => m[0].length + 1)),
        );
        text = `${fence} ${raw} ${fence}`;
      } else {
        if (a?.bold) text = `**${text}**`;
        if (a?.italic) text = `*${text}*`;
        if (a?.strikethrough) text = `~~${text}~~`;
        if (a?.underline) text = `<u>${text}</u>`;
      }
      const url = item.href ?? item.text?.link?.url;
      return url ? `[${text}](<${url.replaceAll(">", "%3E")}>)` : text;
    })
    .join("");
}
const payloadSchema = z.object({ rich_text: textSchema });
const mediaSchema = z.object({
  type: z.enum(["file", "external"]),
  file: z.object({ url: z.string().url() }).optional(),
  external: z.object({ url: z.string().url() }).optional(),
  caption: textSchema,
});
export async function toMarkdown(
  blocks: RemoteBlock[],
  image: (block: RemoteBlock, url: string, internal: boolean) => Promise<string>,
): Promise<string> {
  const result: string[] = [];
  let previousList = false;
  for (const block of blocks) {
    const payload = block[block.type];
    const children = block.children.length ? await toMarkdown(block.children, image) : "";
    const type = block.type;
    let text: string;
    const list = ["bulleted_list_item", "numbered_list_item", "to_do"].includes(type);
    switch (type) {
      case "paragraph":
      case "heading_1":
      case "heading_2":
      case "heading_3":
      case "bulleted_list_item":
      case "numbered_list_item":
      case "to_do":
      case "quote":
      case "callout":
      case "toggle": {
        text = rich(payloadSchema.parse(payload).rich_text);
        if (type.startsWith("heading_")) text = `${"#".repeat(Number(type.at(-1)))} ${text}`;
        if (list) {
          const checked =
            type === "to_do" ? z.object({ checked: z.boolean() }).parse(payload).checked : false;
          text = `${type === "numbered_list_item" ? "1. " : type === "to_do" ? `- [${checked ? "x" : " "}] ` : "- "}${text}`;
          if (children)
            text += `\n${children
              .trimEnd()
              .split("\n")
              .map((line) => `    ${line}`)
              .join("\n")}`;
        } else if (type === "quote" || type === "callout") {
          text =
            `${type === "callout" ? "[!note] " : ""}${text}${children ? `\n\n${children.trimEnd()}` : ""}`
              .split("\n")
              .map((line) => `> ${line}`)
              .join("\n");
        } else text += children ? `\n\n${children.trimEnd()}` : "";
        break;
      }
      case "code": {
        const code = z.object({ rich_text: textSchema, language: z.string() }).parse(payload);
        const raw = rich(code.rich_text, true);
        const fence = "`".repeat(
          Math.max(3, ...[...raw.matchAll(/`+/g)].map((m) => m[0].length + 1)),
        );
        text = `${fence}${code.language === "plain text" ? "" : code.language}\n${raw}\n${fence}`;
        break;
      }
      case "divider":
        text = "---";
        break;
      case "image": {
        const media = mediaSchema.parse(payload);
        const url = media.type === "file" ? media.file?.url : media.external?.url;
        if (!url) throw new Error("Notion 图片缺少下载地址。");
        text = await image(block, url, media.type === "file");
        const caption = rich(media.caption);
        if (caption) text += `\n\n${caption}`;
        break;
      }
      case "table": {
        const rows = block.children.map((row) =>
          z
            .object({ cells: z.array(textSchema) })
            .parse(row.table_row)
            .cells.map((cell) => rich(cell).replaceAll("|", "\\|").replaceAll("\n", "<br>")),
        );
        if (!rows.length) throw new Error("Notion 表格没有行。");
        const width = rows[0]?.length ?? 0;
        text = rows.map((row) => `| ${row.join(" | ")} |`).join("\n");
        const lines = text.split("\n");
        if (!z.object({ has_column_header: z.boolean() }).parse(payload).has_column_header)
          lines.unshift(`| ${Array.from({ length: width }, () => " ").join(" | ")} |`);
        lines.splice(1, 0, `| ${Array.from({ length: width }, () => "---").join(" | ")} |`);
        text = lines.join("\n");
        break;
      }
      case "table_row":
        continue;
      case "equation":
        text = `$$\n${z.object({ expression: z.string() }).parse(payload).expression}\n$$`;
        break;
      case "bookmark":
      case "link_preview": {
        const url = z.object({ url: z.string().url() }).parse(payload).url;
        text = `<${url}>`;
        break;
      }
      default:
        throw new Error(`暂不支持拉取 Notion 区块 ${type}；已停止转换，原笔记保持不变。`);
    }
    if (result.length) result.push(list && previousList ? "\n" : "\n\n");
    result.push(text);
    previousList = list;
  }
  return result.join("") + (result.length ? "\n" : "");
}

export function frontmatter(source: string): string {
  return source.match(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/)?.[0] ?? "";
}
export function preserveFrontmatter(local: string, remote: string): string {
  return frontmatter(local) + remote;
}
export function requireUnchanged(current: string, reviewed: string): void {
  if (current !== reviewed)
    throw new Error("审阅期间本地笔记已修改，请重新拉取并审阅；没有写入原笔记。");
}

export function revision(blocks: RemoteBlock[]): string {
  return JSON.stringify(blocks, (key, value: unknown) => {
    if (key === "expiry_time") return undefined;
    if (key === "url" && typeof value === "string") {
      try {
        const url = new URL(value);
        if (url.hostname.endsWith("amazonaws.com") || url.hostname.endsWith("notion.so"))
          return url.origin + url.pathname;
      } catch {
        /* Non-URL values are compared verbatim. */
      }
    }
    return value;
  });
}

export async function publishedMarkdown(
  blocks: Block[],
  images: Map<string, string>,
): Promise<string> {
  function tree(block: Block): RemoteBlock {
    const data = z.record(z.string(), z.unknown()).parse(block[block.type]);
    const children = data.children
      ? z
          .array(z.object({ type: z.string() }).passthrough())
          .parse(data.children)
          .map(tree)
      : [];
    if (block.type === "image" && data.type === "file_upload") {
      const upload = z.object({ id: z.string() }).parse(data.file_upload);
      return {
        id: crypto.randomUUID(),
        type: "image",
        has_children: false,
        children: [],
        image: {
          type: "file",
          file: { url: `https://local.invalid/${upload.id}` },
          caption: data.caption ?? [],
        },
      };
    }
    return {
      ...block,
      id: crypto.randomUUID(),
      type: block.type,
      has_children: !!children.length,
      children,
    };
  }
  return toMarkdown(blocks.map(tree), async (_block, url, internal) => {
    if (!internal) return `![](<${url.replaceAll(">", "%3E")}>)`;
    const path = images.get(new URL(url).pathname.slice(1));
    if (!path) throw new Error("本地发布投影缺少图片路径。");
    return `![[${path}]]`;
  });
}
