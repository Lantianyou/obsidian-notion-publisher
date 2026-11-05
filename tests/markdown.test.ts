import { describe, expect, it } from "vite-plus/test";
import { convert, type Attachment } from "../src/markdown";
const bytes = new Uint8Array([0, 1, 255]).buffer;
const image: Attachment = {
  path: "assets/图片.png",
  name: "图片.png",
  mime: "image/png",
  data: bytes,
};
const id = "11111111-1111-4111-8111-111111111111";

describe("Markdown and images", () => {
  it("uploads wiki and Markdown images once, preserving code and formatting", async () => {
    const uploaded: string[] = [];
    const blocks = await convert(
      "---\nsecret: hidden\n---\n# 标题\n\n**粗体**\n\n![[图片.png|300]]\n\n![描述](assets/图片.png)\n\n```md\n![[code.png]]\n```",
      async () => image,
      async (file) => {
        uploaded.push(file.path);
        return id;
      },
    );
    expect(uploaded).toEqual([image.path]);
    const serialized = JSON.stringify(blocks);
    expect(serialized).toContain("file_upload");
    expect(serialized.match(/file_upload/g)?.length).toBe(4);
    expect(serialized).toContain("code.png");
    expect(serialized).not.toContain("hidden");
    expect(serialized).toContain("heading_1");
    expect(serialized).toContain('"bold":true');
    expect(serialized).not.toContain("obsidian-upload.invalid");
  });
  it("resolves all files before uploading", async () => {
    let uploads = 0;
    await expect(
      convert(
        "![[ok.png]]\n\n![[missing.png]]",
        async (link) => {
          if (link === "missing.png") throw new Error("missing");
          return image;
        },
        async () => {
          uploads++;
          return id;
        },
      ),
    ).rejects.toThrow("missing");
    expect(uploads).toBe(0);
  });
  it("keeps remote images remote and handles reference images", async () => {
    const blocks = await convert(
      "![本地][pic]\n\n[pic]: assets/图片.png\n\n![remote](https://example.org/a.png)",
      async () => image,
      async () => id,
    );
    expect(JSON.stringify(blocks)).toContain("file_upload");
    expect(JSON.stringify(blocks)).toContain("https://example.org/a.png");
  });
  it("rejects oversized attachments", async () => {
    await expect(
      convert(
        "![[large.png]]",
        async () => ({ ...image, data: new ArrayBuffer(5 * 1024 * 1024 + 1) }),
        async () => id,
      ),
    ).rejects.toThrow("5 MB");
  });
});

it("preserves nested tasks, tables and image order", async () => {
  const blocks = await convert(
    "- [x] **Done**\n  - Nested\n\n| A | B |\n| - | - |\n| 1 | 2 |\n\nBefore ![pic](https://example.org/p.png) after",
    async () => image,
    async () => id,
  );
  expect(blocks[0]?.type).toBe("to_do");
  expect(JSON.stringify(blocks[0])).toContain("bulleted_list_item");
  expect(blocks[1]?.type).toBe("table");
  expect(blocks.slice(2).map((block) => block.type)).toEqual(["paragraph", "image", "paragraph"]);
});
it("publishes image tables as labelled blocks, including escaped wiki width suffixes", async () => {
  const resolved: string[] = [];
  const blocks = await convert(
    "| Pipette | Tips |\n| - | - |\n| ![[pipette.png\\|220]] | ![tips](tips.png) |\n| text cell | ![[second.png]] |",
    async (link) => {
      resolved.push(link);
      return { ...image, path: link };
    },
    async () => id,
  );
  expect(resolved).toEqual(["pipette.png", "tips.png", "second.png"]);
  expect(blocks.filter((block) => block.type === "image")).toHaveLength(3);
  expect(JSON.stringify(blocks)).toContain("Pipette");
  expect(JSON.stringify(blocks)).toContain("Tips");
  expect(JSON.stringify(blocks)).toContain("text cell");
  expect(JSON.stringify(blocks)).not.toContain("obsidian-upload.invalid");
  expect(blocks.some((block) => block.type === "table")).toBe(false);
});

it("recognizes wiki image filenames before GFM email autolinks and emphasis", async () => {
  const resolved: string[] = [];
  const blocks = await convert(
    "![[Screenshot with spaces@2x.png]]\n\n![[image_a_b.png]]\n\n`![[code@2x.png]]`\n\n```md\n![[fenced@2x.png]]\n```",
    async (link) => {
      resolved.push(link);
      return { ...image, path: link };
    },
    async () => id,
  );
  expect(resolved).toEqual(["Screenshot with spaces@2x.png", "image_a_b.png"]);
  expect(blocks.filter((block) => block.type === "image")).toHaveLength(2);
  expect(JSON.stringify(blocks)).toContain("![[code@2x.png]]");
  expect(JSON.stringify(blocks)).toContain("![[fenced@2x.png]]");
});

it("typesets prose arrows while preserving code and link targets", async () => {
  const blocks = await convert(
    "# A -> B\n\nA -> B **C -> D** [next -> step](https://example.org/a->b) `x->y`\n\n```cpp\nx->y\n```\n\n| Flow |\n| --- |\n| A -> B |",
    async () => image,
    async () => id,
  );
  expect(JSON.stringify(blocks[0])).toContain("A → B");
  expect(JSON.stringify(blocks[1])).toContain("C → D");
  expect(JSON.stringify(blocks[1])).toContain("next → step");
  expect(JSON.stringify(blocks[1])).toContain("https://example.org/a->b");
  expect(JSON.stringify(blocks[1])).toContain("x->y");
  expect(JSON.stringify(blocks[2])).toContain("x->y");
  expect(JSON.stringify(blocks[3])).toContain("A → B");
});

it("puts quote text in the quote itself and preserves remaining blocks", async () => {
  const blocks = await convert(
    "> **Quote** -> result\n>\n> Second paragraph\n>\n> - detail",
    async () => image,
    async () => id,
  );
  expect(blocks[0]).toMatchObject({
    type: "quote",
    quote: {
      rich_text: [
        { text: { content: "Quote" }, annotations: { bold: true } },
        { text: { content: " → result" } },
      ],
      children: [{ type: "paragraph" }, { type: "bulleted_list_item" }],
    },
  });
});

it("maps Obsidian callouts to native callouts with formatted titles and body", async () => {
  const blocks = await convert(
    "> [!warning]- **Watch** -> next\n> Body<br>line\n>\n> - detail\n\n> [!note]\n> Only body",
    async () => image,
    async () => id,
  );
  expect(blocks[0]).toMatchObject({
    type: "callout",
    callout: {
      icon: { type: "emoji", emoji: "⚠️" },
      color: "yellow_background",
      rich_text: [
        { text: { content: "Watch" }, annotations: { bold: true } },
        { text: { content: " → next" } },
      ],
      children: [
        {
          type: "paragraph",
          paragraph: {
            rich_text: [
              { text: { content: "Body" } },
              { text: { content: "\n" } },
              { text: { content: "line" } },
            ],
          },
        },
        { type: "bulleted_list_item" },
      ],
    },
  });
  expect(blocks[1]).toMatchObject({
    type: "callout",
    callout: { rich_text: [{ text: { content: "Note" } }], children: [{ type: "paragraph" }] },
  });
  expect(JSON.stringify(blocks)).not.toContain("[!warning]");
});

it("preserves autolinks, quote images, nested callouts and unknown callout titles", async () => {
  const blocks = await convert(
    "https://example.org/a->b\n\n> before ![pic](https://example.org/q.png) after\n\n> [!custom]\n> ![body](https://example.org/body.png)\n>\n> > [!tip] Nested",
    async () => image,
    async () => id,
  );
  expect(JSON.stringify(blocks[0])).toContain("https://example.org/a->b");
  expect(blocks[1]).toMatchObject({
    type: "quote",
    quote: {
      rich_text: [{ text: { content: "before " } }],
      children: [{ type: "image" }, { type: "paragraph" }],
    },
  });
  expect(blocks[2]).toMatchObject({
    type: "callout",
    callout: {
      rich_text: [{ text: { content: "Custom" } }],
      children: [{ type: "image" }, { type: "callout" }],
    },
  });
});
