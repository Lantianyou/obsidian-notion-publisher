import { z } from "zod";
import type { Block, Notion } from "./notion";

export const mappingSchema = z.object({ page: z.string().uuid(), url: z.string().url() });
export type Mapping = z.infer<typeof mappingSchema>;
export type PublisherApi = Pick<Notion, "createPage" | "append">;

export async function publish(args: {
  api: PublisherApi;
  parent: string;
  title: string;
  blocks: Block[];
  save: (mapping: Mapping) => Promise<void>;
}): Promise<Mapping> {
  const { api, parent, title, blocks, save } = args;
  const page = await api.createPage(parent, title);
  const mapping = { page: page.id, url: page.url };
  try {
    await appendTree(api, page.id, blocks);
    await save(mapping);
    return mapping;
  } catch (error) {
    const message = error instanceof Error ? error.message : "请求失败";
    throw new Error(`发布未完成：${message}\n新页面：${page.url}`);
  }
}

const blockSchema = z.object({ type: z.string() }).passthrough();

async function appendTree(api: PublisherApi, parent: string, blocks: Block[]): Promise<void> {
  for (let offset = 0; offset < blocks.length; offset += 50) {
    const batch = blocks.slice(offset, offset + 50).map((block) => {
      const payload = block[block.type];
      if (!payload || typeof payload !== "object" || !("children" in payload))
        return { block, children: [], skip: 0 };
      const children = z.array(blockSchema).parse(payload.children);
      const { children: _children, ...rest } = payload;
      // Tables require at least one row in the creation request.
      const skip = block.type === "table" ? Math.min(50, children.length) : 0;
      return {
        block: {
          ...block,
          [block.type]: { ...rest, ...(skip ? { children: children.slice(0, skip) } : {}) },
        },
        children,
        skip,
      };
    });
    const created = await api.append(
      parent,
      batch.map((item) => item.block),
    );
    if (created.length !== batch.length) throw new Error("Notion 返回的区块数量不匹配。");
    for (const [index, item] of batch.entries()) {
      const target = created[index];
      if (target && item.children.length > item.skip)
        await appendTree(api, target.id, item.children.slice(item.skip));
    }
  }
}
