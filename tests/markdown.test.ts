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
it("rejects images inside table cells before uploading", async () => {
  let uploads = 0;
  await expect(
    convert(
      "| Image |\n| - |\n| ![[pic.png]] |",
      async () => image,
      async () => {
        uploads++;
        return id;
      },
    ),
  ).rejects.toThrow("表格");
  expect(uploads).toBe(0);
});
