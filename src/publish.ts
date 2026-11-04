import { z } from "zod";
import type { Block, Notion } from "./notion";

export const mappingSchema = z.object({
  page: z.string().uuid(),
  url: z.string().url(),
  active: z.string().uuid().nullable(),
  staging: z.string().uuid().nullable(),
  retired: z.array(z.string().uuid()),
});
export type Mapping = z.infer<typeof mappingSchema>;
export type PublisherApi = Pick<Notion, "createPage" | "rename" | "append" | "archive">;

export async function publish(args: {
  api: PublisherApi;
  parent: string;
  title: string;
  blocks: Block[];
  mapping?: Mapping;
  save: (mapping: Mapping) => Promise<void>;
}): Promise<Mapping> {
  const { api, parent, title, blocks, save } = args;
  let state = args.mapping;
  if (!state) {
    const page = await api.createPage(parent, title);
    state = { page: page.id, url: page.url, active: null, staging: null, retired: [] };
    await save(state);
  }
  if (state.staging) {
    await api.archive(state.staging);
    state = { ...state, staging: null };
    await save(state);
  }
  for (const id of state.retired) await api.archive(id);
  state = { ...state, retired: [] };
  await save(state);
  const result = await api.append(state.page, [
    {
      type: "toggle",
      toggle: { rich_text: [{ type: "text", text: { content: "笔记正文 · Obsidian" } }] },
    },
  ]);
  const container = result[0];
  if (!container) throw new Error("Notion 未返回正文容器。");
  state = { ...state, staging: container.id };
  await save(state);
  await appendTree(api, container.id, blocks);
  await api.rename(state.page, title);
  state = {
    ...state,
    active: container.id,
    staging: null,
    retired: state.active ? [state.active] : [],
  };
  await save(state);
  for (const id of state.retired) await api.archive(id);
  state = { ...state, retired: [] };
  await save(state);
  return state;
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
    if (created.length !== batch.length)
      throw new Error("Notion 返回的区块数量不匹配；旧版正文已保留。");
    for (const [index, item] of batch.entries()) {
      const target = created[index];
      if (target && item.children.length > item.skip)
        await appendTree(api, target.id, item.children.slice(item.skip));
    }
  }
}
