import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import { visit } from "unist-util-visit";
import type { RootContent, PhrasingContent, Root } from "mdast";
import type { Block } from "./notion";

export type Attachment = { path: string; name: string; mime: string; data: ArrayBuffer };
export type ImageResolver = (link: string) => Promise<Attachment>;
const formats: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  ico: "image/x-icon",
  heic: "image/heic",
};
export function imageMime(extension: string): string {
  const mime = formats[extension.toLowerCase()];
  if (!mime) throw new Error(`暂不支持图片格式：${extension}。请转换为 PNG、JPEG 或 WebP。`);
  return mime;
}

export async function convert(
  markdown: string,
  resolve: ImageResolver,
  upload: (image: Attachment) => Promise<string>,
): Promise<Block[]> {
  const processor = unified().use(remarkParse).use(remarkGfm);
  const body = markdown.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "");
  const tree = processor.parse(normalizeWikiEmbeds(body));
  const definitions = new Map<string, string>();
  visit(tree, "definition", (node) => {
    definitions.set(node.identifier.toLowerCase(), node.url);
  });
  visit(tree, "imageReference", (node, index, parent) => {
    const url = definitions.get(node.identifier.toLowerCase());
    if (!url) throw new Error(`图片引用未定义：${node.identifier}`);
    if (parent && typeof index === "number")
      parent.children[index] = { type: "image", url, alt: node.alt ?? "" };
  });
  const images: { url: string }[] = [];
  visit(tree, "image", (node, _index, parent) => {
    if (parent?.type !== "paragraph" && parent?.type !== "heading" && parent?.type !== "tableCell")
      throw new Error("暂不支持粗体、链接等行内格式内嵌套图片；请将图片放在段落或表格单元格中。");
    images.push(node);
  });
  const cache = new Map<string, string>();
  const uploads = new Map<string, string>();
  // Resolve every local image before the first upload, so missing files fail early.
  const local: { node: { url: string }; image: Attachment }[] = [];
  for (const node of images) {
    if (/^https?:\/\//i.test(node.url)) continue;
    if (/^[a-z][a-z\d+.-]*:/i.test(node.url)) throw new Error(`不支持的图片地址：${node.url}`);
    local.push({ node, image: await resolve(decodeURIComponent(node.url)) });
  }
  for (const { image } of local) {
    if (image.data.byteLength > 5 * 1024 * 1024)
      throw new Error(`图片超过第一版的 5 MB 上限：${image.name}`);
  }
  for (const { node, image } of local) {
    let placeholder = cache.get(image.path);
    if (!placeholder) {
      const id = await upload(image);
      placeholder = `https://obsidian-upload.invalid/${id}`;
      cache.set(image.path, placeholder);
      uploads.set(placeholder, id);
    }
    node.url = placeholder;
  }
  return render(tree, uploads);
}

function normalizeWikiEmbeds(markdown: string): string {
  const tree = unified().use(remarkParse).parse(markdown);
  const excluded: { start: number; end: number }[] = [];
  visit(tree, (node) => {
    if (node.type !== "code" && node.type !== "inlineCode" && node.type !== "html") return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start !== undefined && end !== undefined) excluded.push({ start, end });
  });
  return markdown.replace(
    /!\[\[([^\]\n]+)\]\]/g,
    (match: string, target: string, offset: number) => {
      if (excluded.some((range) => offset >= range.start && offset < range.end)) return match;
      const [path = "", alias = ""] = target.replaceAll("\\|", "|").split("|");
      const alt = (/^\d+(x\d+)?$/.test(alias) ? "" : alias).replace(/[\\[\]]/g, "\\$&");
      const url = /^https?:\/\//i.test(path)
        ? encodeURI(path)
        : encodeURIComponent(path).replaceAll("%2F", "/");
      return `![${alt}](<${url}>)`;
    },
  );
}

type RichText = {
  type: "text";
  text: { content: string; link?: { url: string } };
  annotations?: { bold?: boolean; italic?: boolean; strikethrough?: boolean; code?: boolean };
};

function text(content: string, annotations?: RichText["annotations"], url?: string): RichText[] {
  const result: RichText[] = [];
  for (let i = 0; i < content.length;) {
    let end = Math.min(i + 1900, content.length);
    const last = content.charCodeAt(end - 1);
    if (end < content.length && last >= 0xd800 && last <= 0xdbff) end--;
    result.push({
      type: "text",
      text: { content: content.slice(i, end), ...(url ? { link: { url } } : {}) },
      ...(annotations ? { annotations } : {}),
    });
    i = end;
  }
  if (result.length > 100) throw new Error("文本超过 Notion 区块上限，请拆分段落或代码块。");
  return result;
}

function render(tree: Root, uploads: Map<string, string>): Block[] {
  const definitions = new Map<string, string>();
  visit(tree, "definition", (node) => {
    definitions.set(node.identifier.toLowerCase(), node.url);
  });
  function inline(
    nodes: PhrasingContent[],
    annotations: RichText["annotations"] = {},
    url?: string,
  ): RichText[] {
    const output = nodes.flatMap((node): RichText[] => {
      switch (node.type) {
        case "text":
          return text(node.value, annotations, url);
        case "inlineCode":
          return text(node.value, { ...annotations, code: true }, url);
        case "break":
          return text("\n", annotations, url);
        case "emphasis":
          return inline(node.children, { ...annotations, italic: true }, url);
        case "strong":
          return inline(node.children, { ...annotations, bold: true }, url);
        case "delete":
          return inline(node.children, { ...annotations, strikethrough: true }, url);
        case "link":
          return inline(
            node.children,
            annotations,
            /^(https?:|mailto:)/i.test(node.url) ? node.url : undefined,
          );
        case "linkReference": {
          const target = definitions.get(node.identifier.toLowerCase());
          return inline(
            node.children,
            annotations,
            target && /^(https?:|mailto:)/i.test(target) ? target : undefined,
          );
        }
        case "image":
          return text(node.alt ?? "", annotations);
        case "imageReference":
          return text(node.alt ?? "", annotations);
        case "html":
          return text(node.value, annotations);
        case "footnoteReference":
          return text(`[^${node.identifier}]`, annotations);
        default: {
          const exhaustive: never = node;
          return exhaustive;
        }
      }
    });
    if (output.length > 100) throw new Error("段落格式片段超过 Notion 的 100 项上限，请拆分段落。");
    return output;
  }
  function richBlock(
    type: string,
    rich_text: RichText[],
    extra: Record<string, unknown> = {},
  ): Block {
    return { type, [type]: { rich_text, ...extra } };
  }
  function paragraph(nodes: PhrasingContent[], type = "paragraph"): Block[] {
    const result: Block[] = [];
    let current: PhrasingContent[] = [];
    const flush = () => {
      if (current.length) result.push(richBlock(type, inline(current)));
      current = [];
    };
    for (const node of nodes) {
      if (node.type !== "image") {
        current.push(node);
        continue;
      }
      flush();
      const id = uploads.get(node.url);
      const caption = text(node.alt ?? "");
      result.push({
        type: "image",
        image: id
          ? { type: "file_upload", file_upload: { id }, caption }
          : { type: "external", external: { url: node.url }, caption },
      });
    }
    flush();
    return result;
  }
  function blocks(nodes: RootContent[]): Block[] {
    return nodes.flatMap((node): Block[] => {
      switch (node.type) {
        case "paragraph":
          return paragraph(node.children);
        case "heading":
          return paragraph(node.children, `heading_${Math.min(3, node.depth)}`);
        case "code":
          return [richBlock("code", text(node.value), { language: language(node.lang ?? "") })];
        case "thematicBreak":
          return [{ type: "divider", divider: {} }];
        case "blockquote":
          return [richBlock("quote", [], { children: blocks(node.children) })];
        case "list":
          return node.children.map((item) => {
            const type =
              typeof item.checked === "boolean"
                ? "to_do"
                : node.ordered
                  ? "numbered_list_item"
                  : "bulleted_list_item";
            const first = item.children[0];
            const firstBlocks = first?.type === "paragraph" ? paragraph(first.children) : [];
            const head = firstBlocks[0];
            const payload = head?.type === "paragraph" ? head.paragraph : undefined;
            const rich_text =
              payload && typeof payload === "object" && "rich_text" in payload
                ? payload.rich_text
                : [];
            const children = [
              ...(head?.type === "paragraph" ? firstBlocks.slice(1) : firstBlocks),
              ...blocks(first?.type === "paragraph" ? item.children.slice(1) : item.children),
            ];
            return {
              type,
              [type]: {
                rich_text,
                ...(typeof item.checked === "boolean" ? { checked: item.checked } : {}),
                ...(children.length ? { children } : {}),
              },
            };
          });
        case "table": {
          let containsImages = false;
          visit(node, "image", () => {
            containsImages = true;
          });
          if (containsImages) {
            const header = node.children[0];
            if (!header) return [];
            // Notion table cells accept rich text only. Keep column labels with each cell.
            const rows = node.children.slice(1);
            return rows.flatMap((row) =>
              row.children.flatMap((cell, column) => [
                richBlock(
                  "paragraph",
                  inline(header.children[column]?.children ?? [], { bold: true }),
                ),
                ...paragraph(cell.children),
              ]),
            );
          }
          const width = Math.max(1, ...node.children.map((row) => row.children.length));
          if (width > 100) throw new Error("表格超过 Notion 的 100 列上限。");
          return [
            {
              type: "table",
              table: {
                table_width: width,
                has_column_header: true,
                has_row_header: false,
                children: node.children.map((row) => ({
                  type: "table_row",
                  table_row: {
                    cells: Array.from({ length: width }, (_, i) =>
                      inline(row.children[i]?.children ?? []),
                    ),
                  },
                })),
              },
            },
          ];
        }
        case "html":
          return [richBlock("paragraph", text(node.value))];
        case "definition":
          return [];
        case "footnoteDefinition":
          return [richBlock("paragraph", text(`[^${node.identifier}]`)), ...blocks(node.children)];
        case "listItem":
          return blocks(node.children);
        case "tableRow":
          return [];
        case "tableCell":
          return paragraph(node.children);
        case "yaml":
          return [];
        case "break":
        case "delete":
        case "emphasis":
        case "footnoteReference":
        case "image":
        case "imageReference":
        case "inlineCode":
        case "link":
        case "linkReference":
        case "strong":
        case "text":
          return paragraph([node]);
        default: {
          const exhaustive: never = node;
          return exhaustive;
        }
      }
    });
  }
  return blocks(tree.children);
}

function language(input: string): string {
  const aliases: Record<string, string> = {
    js: "javascript",
    ts: "typescript",
    py: "python",
    sh: "shell",
    bash: "bash",
    md: "markdown",
    yml: "yaml",
    cs: "c#",
    cpp: "c++",
    txt: "plain text",
    text: "plain text",
  };
  const value = aliases[input.toLowerCase()] ?? input.toLowerCase();
  return [
    "javascript",
    "typescript",
    "python",
    "shell",
    "bash",
    "markdown",
    "yaml",
    "json",
    "html",
    "css",
    "sql",
    "rust",
    "go",
    "java",
    "c",
    "c#",
    "c++",
    "ruby",
    "swift",
    "kotlin",
    "xml",
    "docker",
    "plain text",
  ].includes(value)
    ? value
    : "plain text";
}
