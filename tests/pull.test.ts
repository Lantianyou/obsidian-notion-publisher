import { expect, it } from "vite-plus/test";
import { toMarkdown, preserveFrontmatter, requireUnchanged, type RemoteBlock } from "../src/pull";
import { assertUnique, moveBindings, revision, type Binding } from "../src/sync-state";
import { Notion } from "../src/notion";
import { updatePage } from "../src/publish";
const id = "11111111-1111-4111-8111-111111111111";
const url = `https://notion.so/${id}`;
function block(type: string, payload: unknown, children: RemoteBlock[] = []): RemoteBlock {
  return {
    id: crypto.randomUUID(),
    type,
    has_children: children.length > 0,
    [type]: payload,
    children,
  };
}
const text = (content: string) => [{ plain_text: content, annotations: {} }];
it("pulls nested lists, tasks, formatted text, and images into editable Markdown", async () => {
  const blocks = [
    block("heading_2", { rich_text: text("Title") }),
    block("bulleted_list_item", { rich_text: text("Parent") }, [
      block("bulleted_list_item", { rich_text: text("Child") }),
    ]),
    block("to_do", { rich_text: text("Done"), checked: true }),
    block("paragraph", {
      rich_text: [
        { plain_text: "bold", annotations: { bold: true } },
        { plain_text: "a[b]", href: "https://example.com" },
      ],
    }),
    block("image", {
      type: "file",
      file: { url: "https://example.com/signed?expires=1" },
      caption: [],
    }),
  ];
  const markdown = await toMarkdown(blocks, async () => "![[local.png]]");
  expect(markdown).toContain("## Title");
  expect(markdown).toContain("- Parent\n    - Child");
  expect(markdown).toContain("- [x] Done");
  expect(markdown).toContain("**bold**[a\\[b\\]](<https://example.com>)");
  expect(markdown).toContain("![[local.png]]");
  expect(markdown).not.toContain("expires");
});
it("refuses unsupported content rather than silently dropping it from a pull", async () => {
  await expect(toMarkdown([block("child_database", {})], async () => "")).rejects.toThrow(
    "child_database",
  );
});
it("preserves YAML and refuses to overwrite edits made during review", () => {
  const local = "---\r\ntags: [test]\r\n---\r\nLocal";
  expect(preserveFrontmatter(local, "Remote\n")).toBe("---\r\ntags: [test]\r\n---\r\nRemote\n");
  expect(() => requireUnchanged(local + " new edit", local)).toThrow("本地笔记已修改");
});
it("keeps a one-to-one association through file and folder renames", () => {
  const bindings: Record<string, Binding> = { "folder/note.md": { page: id, url } };
  expect(() => assertUnique(bindings, "other.md", id)).toThrow("folder/note.md");
  expect(() => assertUnique(bindings, "folder/note.md", id)).not.toThrow();
  moveBindings(bindings, "folder", "new folder");
  moveBindings(bindings, "new folder/note.md", "new folder/renamed.md");
  expect(Object.keys(bindings)).toEqual(["new folder/renamed.md"]);
  expect(bindings["new folder/renamed.md"]?.page).toBe(id);
});
it("reads every page of children and recursively reads nested content", async () => {
  const child = block("paragraph", { rich_text: text("nested") });
  const parent = block("bulleted_list_item", { rich_text: text("list") }, [child]);
  const last = block("paragraph", { rich_text: text("last") });
  const paths: string[] = [];
  const api = new Notion("token", async (request) => {
    paths.push(request.url);
    const u = new URL(request.url);
    const nested = u.pathname.includes(parent.id);
    return {
      status: 200,
      headers: {},
      body: {
        results: nested ? [child] : u.searchParams.has("start_cursor") ? [last] : [parent],
        has_more: !nested && !u.searchParams.has("start_cursor"),
        next_cursor: !nested && !u.searchParams.has("start_cursor") ? "next cursor" : null,
      },
    };
  });
  const result = await api.tree(id);
  expect(result).toHaveLength(2);
  expect(result[0]?.children[0]?.paragraph).toEqual(child.paragraph);
  expect(paths.some((path) => path.includes("start_cursor=next%20cursor"))).toBe(true);
});
it("ignores rotating signed image parameters while detecting changed content", () => {
  const image = block("image", {
    type: "file",
    file: {
      url: "https://s3.us-west-2.amazonaws.com/bucket/file.png?expires=1",
      expiry_time: "one",
    },
    caption: [],
  });
  const rotated = {
    ...image,
    image: {
      type: "file",
      file: {
        url: "https://s3.us-west-2.amazonaws.com/bucket/file.png?expires=2",
        expiry_time: "two",
      },
      caption: [],
    },
  };
  expect(revision([image])).toBe(revision([rotated]));
  expect(revision([image])).not.toBe(
    revision([{ ...rotated, image: { ...rotated.image, caption: text("changed") } }]),
  );
});
it("updates the same page, appends complete new content before archiving old content", async () => {
  const old = block("paragraph", { rich_text: text("old") });
  const next = block("paragraph", { rich_text: text("new") });
  const actions: string[] = [];
  let reads = 0;
  const api = {
    tree: async () => (++reads === 1 ? [old] : [old, next]),
    append: async (target: string) => {
      actions.push(`append:${target}`);
      return [{ id: next.id }];
    },
    archiveBlock: async (target: string) => {
      actions.push(`archive:${target}`);
    },
  };
  expect(
    await updatePage({
      api,
      mapping: { page: id, url },
      blocks: [next],
      expectedRevision: revision([old]),
    }),
  ).toEqual({ page: id, url });
  expect(actions).toEqual([`append:${id}`, `archive:${old.id}`]);
});
it("does not change the page when remote content changed after review", async () => {
  let writes = 0;
  await expect(
    updatePage({
      api: {
        tree: async () => [block("paragraph", { rich_text: text("changed") })],
        append: async () => {
          writes++;
          return [];
        },
        archiveBlock: async () => {
          writes++;
        },
      },
      mapping: { page: id, url },
      blocks: [],
      expectedRevision: revision([]),
    }),
  ).rejects.toThrow("变化");
  expect(writes).toBe(0);
});
it("keeps old remote content when appending fails", async () => {
  const old = block("paragraph", { rich_text: text("old") });
  let deletes = 0;
  await expect(
    updatePage({
      api: {
        tree: async () => [old],
        append: async () => {
          throw new Error("network");
        },
        archiveBlock: async () => {
          deletes++;
        },
      },
      mapping: { page: id, url },
      blocks: [{ type: "paragraph", paragraph: { rich_text: [] } }],
      expectedRevision: revision([old]),
    }),
  ).rejects.toThrow("旧正文已保留");
  expect(deletes).toBe(0);
});
