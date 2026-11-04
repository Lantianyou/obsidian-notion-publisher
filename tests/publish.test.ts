import { expect, it } from "vite-plus/test";
import { publish, type Mapping, type PublisherApi } from "../src/publish";
const page = "11111111-1111-4111-8111-111111111111";
const old = "22222222-2222-4222-8222-222222222222";
const next = "33333333-3333-4333-8333-333333333333";
const initial: Mapping = {
  page,
  url: "https://notion.so/test",
  active: old,
  staging: null,
  retired: [],
};
function fixture(fail = false) {
  const events: string[] = [];
  const states: Mapping[] = [];
  const api: PublisherApi = {
    createPage: async () => {
      throw new Error("must reuse existing page");
    },
    rename: async () => {
      events.push("rename");
    },
    archive: async (id) => {
      events.push(`archive:${id}`);
    },
    append: async (id, children) => {
      events.push(`append:${id}:${children.length}`);
      if (id === next && fail) throw new Error("write failed");
      return children.map(() => ({ id: next }));
    },
  };
  return {
    api,
    events,
    states,
    save: async (state: Mapping) => {
      states.push(structuredClone(state));
      events.push(`save:${state.active}`);
    },
  };
}
it("writes the full new generation before retiring the old one", async () => {
  const f = fixture();
  const result = await publish({
    ...f,
    parent: page,
    title: "Note",
    blocks: Array.from({ length: 101 }, () => ({ type: "paragraph" })),
    mapping: initial,
  });
  expect(f.events.filter((e) => e.startsWith(`append:${next}`))).toEqual([
    `append:${next}:50`,
    `append:${next}:50`,
    `append:${next}:1`,
  ]);
  expect(f.events.indexOf(`archive:${old}`)).toBeGreaterThan(f.events.indexOf(`save:${next}`));
  expect(result.active).toBe(next);
  expect(result.retired).toEqual([]);
});
it("keeps old content and records staging when writing fails", async () => {
  const f = fixture(true);
  await expect(
    publish({
      ...f,
      parent: page,
      title: "Note",
      blocks: [{ type: "paragraph" }],
      mapping: initial,
    }),
  ).rejects.toThrow("write failed");
  expect(f.events).not.toContain(`archive:${old}`);
  expect(f.states.at(-1)).toMatchObject({ active: old, staging: next });
});
it("cleans interrupted staging before retry", async () => {
  const f = fixture();
  await publish({
    ...f,
    parent: page,
    title: "Note",
    blocks: [],
    mapping: { ...initial, staging: next },
  });
  expect(f.events[0]).toBe(`archive:${next}`);
});

it("writes nested children after their parents to respect Notion depth limits", async () => {
  const requests: { id: string; children: unknown[] }[] = [];
  const f = fixture();
  const api: PublisherApi = {
    ...f.api,
    append: async (id, children) => {
      requests.push({ id, children });
      return children.map(() => ({ id: crypto.randomUUID() }));
    },
  };
  await publish({
    ...f,
    api,
    parent: page,
    title: "Nested",
    mapping: initial,
    blocks: [
      {
        type: "bulleted_list_item",
        bulleted_list_item: {
          rich_text: [],
          children: [
            {
              type: "bulleted_list_item",
              bulleted_list_item: {
                rich_text: [],
                children: [{ type: "paragraph", paragraph: { rich_text: [] } }],
              },
            },
          ],
        },
      },
    ],
  });
  expect(requests).toHaveLength(4);
  for (const request of requests)
    expect(JSON.stringify(request.children)).not.toContain('"children"');
});
