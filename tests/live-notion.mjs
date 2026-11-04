import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { createHash } from "node:crypto";

const [mode, settingsPath, imagePath] = process.argv.slice(2);
assert.ok(["first", "second"].includes(mode), "Use first or second");
assert.ok(settingsPath && imagePath, "Pass the local plugin settings path and fixture image path");
const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
const mappings = Object.values(settings.notes);
assert.equal(mappings.length, 1, "Use a test installation with one note");
const mapping = mappings[0];
async function api(path, method = "GET", body) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${settings.token}`,
      "Notion-Version": "2026-03-11",
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Notion HTTP ${response.status} for ${method} ${path}`);
  return response.json();
}
async function children(id) {
  const all = [];
  let cursor;
  do {
    const result = await api(
      `/blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`,
    );
    all.push(...result.results);
    cursor = result.has_more ? result.next_cursor : null;
  } while (cursor);
  return all;
}
async function walk(id) {
  const result = [];
  for (const block of await children(id)) {
    result.push(block);
    if (block.has_children) result.push(...(await walk(block.id)));
  }
  return result;
}
const root = await children(mapping.page);
const blocks = await walk(mapping.active);
const images = blocks.filter((block) => block.type === "image");
assert.equal(images.length, 2, "Wiki and Markdown embeds must both become image blocks");
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const expected = digest(await fs.readFile(imagePath));
for (const block of images) {
  assert.equal(block.image.type, "file", "Images must be hosted by Notion");
  // Signed media URLs receive no Integration Authorization header.
  const response = await fetch(block.image.file.url);
  assert.ok(response.ok, "Published image must be downloadable");
  assert.equal(
    digest(new Uint8Array(await response.arrayBuffer())),
    expected,
    "Image bytes must match the vault file",
  );
}
const serialized = JSON.stringify(blocks);
for (const type of [
  "heading_1",
  "heading_2",
  "to_do",
  "bulleted_list_item",
  "table",
  "table_row",
  "code",
  "quote",
]) {
  assert.ok(
    blocks.some((block) => block.type === type),
    `Missing block type: ${type}`,
  );
}
assert.ok(!serialized.includes("notion-publisher-id"), "Frontmatter must not be published");
assert.equal(mapping.staging, null);
assert.deepEqual(mapping.retired, []);
await fs.mkdir(new URL("../.local-live/", import.meta.url), { recursive: true });
const snapshotPath = new URL("../.local-live/first.json", import.meta.url);
if (mode === "first") {
  const sentinel = await api(`/blocks/${mapping.page}/children`, "PATCH", {
    children: [
      {
        type: "paragraph",
        paragraph: {
          rich_text: [{ type: "text", text: { content: "保留测试：这段内容位于插件正文之外。" } }],
        },
      },
    ],
  });
  await fs.writeFile(
    snapshotPath,
    JSON.stringify({
      page: mapping.page,
      active: mapping.active,
      sentinel: sentinel.results[0].id,
    }),
  );
} else {
  const first = JSON.parse(await fs.readFile(snapshotPath, "utf8"));
  assert.equal(mapping.page, first.page, "Second publish must update the same page");
  assert.notEqual(mapping.active, first.active, "Second publish must commit a new generation");
  assert.equal(
    (await api(`/blocks/${first.active}`)).in_trash,
    true,
    "Old generation must be archived",
  );
  assert.ok(
    root.some((block) => block.id === first.sentinel),
    "Content outside the managed container must survive",
  );
  assert.ok(serialized.includes("SECOND_PUBLISH_VERIFIED"), "Updated note text must be present");
  assert.equal(
    root.filter((block) => block.type === "toggle").length,
    1,
    "Only one managed generation should remain visible",
  );
}
const report = {
  mode,
  page: mapping.page,
  url: mapping.url,
  imageCount: images.length,
  imageBytesMatch: true,
  blockCount: blocks.length,
  staging: mapping.staging,
  cleanupComplete: true,
};
await fs.writeFile(
  new URL(`../.local-live/${mode}-report.json`, import.meta.url),
  JSON.stringify(report, null, 2),
);
console.info(JSON.stringify(report, null, 2));
