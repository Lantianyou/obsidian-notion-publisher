// Reads the installed plugin state and visible review. Never approves, publishes, or changes a note.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const [vaultPath, notePath, pageInput] = process.argv.slice(2);
assert.ok(
  vaultPath && notePath && pageInput,
  "Usage: node tests/live-pull.mjs /path/to/vault 'Note.md' notion-page-id",
);
const expectedPage = pageInput.replaceAll("-", "").toLowerCase();
const pluginDir = path.join(vaultPath, ".obsidian/plugins/notion-note-publisher");
const settings = JSON.parse(await fs.readFile(path.join(pluginDir, "data.json"), "utf8"));
const binding = settings.bindings[notePath];
assert.equal(binding.page.replaceAll("-", "").toLowerCase(), expectedPage);
assert.equal(
  Object.values(settings.bindings).filter((value) => value.page === binding.page).length,
  1,
);
assert.ok(
  binding.pending,
  "Run the pull command in Obsidian first and leave the review unapproved.",
);
const review = JSON.parse(await fs.readFile(path.join(vaultPath, binding.pending), "utf8"));
const current = await fs.readFile(path.join(vaultPath, notePath), "utf8");
assert.equal(
  current,
  review.local,
  "The original note must match the content captured before the pull.",
);
assert.equal(review.session.document, review.local);
assert.ok(review.session.hunks.every((hunk) => hunk.decision.kind === "pending"));
assert.equal(review.page, binding.page);
assert.ok(review.remote.length > 0);
assert.ok(
  !review.remote.includes("X-Amz-Signature="),
  "No temporary Notion image URLs in Markdown.",
);
const code = `JSON.stringify({title:document.querySelector('.modal-title')?.textContent,editor:document.querySelector('textarea[aria-label="此处修改"]')?.value,links:[...document.querySelectorAll('.notion-publisher-bar a')].map(a=>a.href),approve:[...document.querySelectorAll('.modal button')].some(b=>b.textContent==='Apply 此处'||b.textContent==='确认同步基线（不改正文）')})`;
const result = execFileSync(
  "obsidian",
  [`vault=${path.basename(vaultPath)}`, "eval", `code=${code}`],
  { encoding: "utf8" },
);
const ui = JSON.parse(result.replace(/^=>\s*/, "").trim());
assert.ok(ui.title?.includes(path.basename(notePath, ".md")));
if (review.session.hunks.length) assert.equal(ui.editor, review.session.hunks[0].proposed);
assert.ok(ui.links.includes(binding.url));
assert.equal(ui.approve, true);
for (const embed of review.remote.matchAll(/!\[\[([^\]]+)\]\]/g)) {
  const target = embed[1];
  if (review.images.some((image) => image.target === target)) {
    const image = review.images.find((image) => image.target === target);
    await fs.access(path.join(vaultPath, image.staged));
  } else await fs.access(path.join(vaultPath, target));
}
const report = {
  page: binding.page,
  note: notePath,
  originalSha256: createHash("sha256").update(current).digest("hex"),
  originalUnchanged: true,
  pendingHunks: review.session.hunks.length,
  oneToOne: true,
  headerLinkVisible: true,
  reviewVisible: true,
  awaitingHumanApproval: true,
  localImages: [...review.remote.matchAll(/!\[\[/g)].length,
  stagedImages: review.images.length,
  pulledAt: review.capturedAt,
};
console.info(JSON.stringify(report, null, 2));
