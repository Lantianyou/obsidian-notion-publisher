import { z } from "zod";
import { remoteBlockSchema, type RemoteBlock } from "./pull";

export type HttpRequest = {
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string | ArrayBuffer;
};
export type HttpResponse = { status: number; headers: Record<string, string>; body: unknown };
export type Transport = (request: HttpRequest) => Promise<HttpResponse>;
export type Block = { type: string; [key: string]: unknown };
const objectSchema = z.object({ id: z.string().uuid() });
const pageSchema = objectSchema.extend({ url: z.string().url() });
const listSchema = z.object({
  results: z.array(objectSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});
const uploadSchema = objectSchema.extend({ status: z.literal("uploaded") });

export function pageId(input: string): string {
  const match = input
    .trim()
    .match(/([a-f\d]{32}|[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12})(?:[?#/]|$)/i);
  if (!match?.[1]) throw new Error("请输入有效的 Notion 页面链接或页面 ID。");
  const raw = match[1].replaceAll("-", "");
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export class Notion {
  constructor(
    private readonly token: string,
    private readonly transport: Transport,
    private readonly wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  ) {}

  async request(
    method: string,
    path: string,
    body?: unknown,
    binary?: { data: ArrayBuffer; contentType: string },
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await this.transport({
        method,
        url: `https://api.notion.com/v1${path}`,
        headers: {
          Authorization: `Bearer ${this.token}`,
          "Notion-Version": "2026-03-11",
          "Content-Type": binary?.contentType ?? "application/json",
        },
        ...(binary
          ? { body: binary.data }
          : body === undefined
            ? {}
            : { body: JSON.stringify(body) }),
      });
      if (response.status === 429 && attempt < 4) {
        const header = Object.entries(response.headers).find(
          ([key]) => key.toLowerCase() === "retry-after",
        )?.[1];
        const seconds = Number(header ?? "1");
        await this.wait(
          Number.isFinite(seconds) ? Math.min(60, Math.max(1, seconds)) * 1000 : 1000,
        );
        continue;
      }
      if (response.status < 200 || response.status >= 300) {
        const parsed = z.object({ message: z.string() }).safeParse(response.body);
        throw new Error(
          `Notion HTTP ${response.status}: ${parsed.success ? parsed.data.message : "请求失败"}${response.status === 404 ? "；请确认目标页面已连接此 Integration。" : ""}`,
        );
      }
      return response.body;
    }
    throw new Error("Notion 请求次数超限，请稍后重试。");
  }

  async retrievePage(id: string) {
    return pageSchema
      .extend({ last_edited_time: z.string(), in_trash: z.boolean().optional() })
      .parse(await this.request("GET", `/pages/${id}`));
  }

  async children(id: string) {
    const result: z.infer<typeof remoteBlockSchema>[] = [];
    let cursor: string | null = null;
    do {
      const list = listSchema
        .extend({ results: z.array(remoteBlockSchema) })
        .parse(
          await this.request(
            "GET",
            `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${encodeURIComponent(cursor)}` : ""}`,
          ),
        );
      result.push(...list.results);
      if (list.has_more && !list.next_cursor) throw new Error("Notion 分页缺少游标。");
      cursor = list.has_more ? list.next_cursor : null;
    } while (cursor);
    return result;
  }

  async tree(id: string): Promise<RemoteBlock[]> {
    const blocks: RemoteBlock[] = [];
    for (const block of await this.children(id)) {
      blocks.push({ ...block, children: block.has_children ? await this.tree(block.id) : [] });
    }
    return blocks;
  }

  async archiveBlock(id: string) {
    await this.request("DELETE", `/blocks/${id}`);
  }

  async createPage(parent: string, title: string) {
    return pageSchema.parse(
      await this.request("POST", "/pages", {
        parent: { type: "page_id", page_id: parent },
        properties: {
          title: {
            type: "title",
            title: [{ type: "text", text: { content: title.slice(0, 2000) } }],
          },
        },
      }),
    );
  }

  async append(id: string, children: Block[]) {
    return listSchema.parse(await this.request("PATCH", `/blocks/${id}/children`, { children }))
      .results;
  }

  async upload(name: string, mime: string, data: ArrayBuffer): Promise<string> {
    const { id } = objectSchema.parse(
      await this.request("POST", "/file_uploads", {
        mode: "single_part",
        filename: name,
        content_type: mime,
      }),
    );
    const boundary = `notionpublisher${crypto.randomUUID().replaceAll("-", "")}`;
    const safeName = name.replace(/["\r\n\\]/g, "_");
    const start = new TextEncoder().encode(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${mime}\r\n\r\n`,
    );
    const end = new TextEncoder().encode(`\r\n--${boundary}--\r\n`);
    const payload = new Uint8Array(start.length + data.byteLength + end.length);
    payload.set(start);
    payload.set(new Uint8Array(data), start.length);
    payload.set(end, start.length + data.byteLength);
    uploadSchema.parse(
      await this.request("POST", `/file_uploads/${id}/send`, undefined, {
        data: payload.buffer,
        contentType: `multipart/form-data; boundary=${boundary}`,
      }),
    );
    return id;
  }
}
