import { expect, it } from "vite-plus/test";
import { publish, mappingSchema, type Mapping, type PublisherApi } from "../src/publish";
const parent = "11111111-1111-4111-8111-111111111111";
function fixture(fail = false) {
  const requests: { id: string; children: unknown[] }[] = [];
  const pages: string[] = [];
  const states: Mapping[] = [];
  const api: PublisherApi = {
    createPage: async () => {
      const id = crypto.randomUUID();
      pages.push(id);
      return { id, url: `https://notion.so/${id}` };
    },
    append: async (id, children) => {
      requests.push({ id, children });
      if (fail) throw new Error("write failed");
      return children.map(() => ({ id: crypto.randomUUID() }));
    },
  };
  return {
    api,
    requests,
    pages,
    states,
    save: async (state: Mapping) => {
      states.push(structuredClone(state));
    },
  };
}
it("publishes directly into a fresh page every time, batching long documents", async () => {
  const f = fixture();
  const blocks = Array.from({ length: 101 }, () => ({
    type: "paragraph",
    paragraph: { rich_text: [] },
  }));
  const first = await publish({ ...f, parent, title: "Note", blocks });
  const second = await publish({ ...f, parent, title: "Note", blocks });
  expect(first.page).not.toBe(second.page);
  expect(f.pages).toHaveLength(2);
  for (const page of f.pages) {
    expect(f.requests.filter((r) => r.id === page).map((r) => r.children.length)).toEqual([
      50, 50, 1,
    ]);
  }
  expect(JSON.stringify(f.requests)).not.toContain("toggle");
  expect(f.states).toEqual([first, second]);
});
it("does not replace the last successful link when publishing fails and includes the partial page URL", async () => {
  const f = fixture(true);
  await expect(
    publish({ ...f, parent, title: "Note", blocks: [{ type: "paragraph" }] }),
  ).rejects.toThrow("https://notion.so/");
  expect(f.states).toEqual([]);
  expect(f.pages).toHaveLength(1);
});
it("publishes empty notes as a fresh empty page", async () => {
  const f = fixture();
  const result = await publish({ ...f, parent, title: "Empty", blocks: [] });
  expect(f.requests).toEqual([]);
  expect(f.states).toEqual([result]);
});
it("loads older saved page links without retaining container state", () => {
  expect(
    mappingSchema.parse({
      page: parent,
      url: "https://notion.so/old",
      active: parent,
      staging: null,
      retired: [],
    }),
  ).toEqual({ page: parent, url: "https://notion.so/old" });
});
it("writes nested children after their parents without a wrapper", async () => {
  const f = fixture();
  await publish({
    ...f,
    parent,
    title: "Nested",
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
  expect(f.requests).toHaveLength(3);
  expect(f.requests[0]?.id).toBe(f.pages[0]);
  for (const request of f.requests)
    expect(JSON.stringify(request.children)).not.toContain('"children"');
});
