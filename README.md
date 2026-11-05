# Notion Note Publisher

Publish one Obsidian note and its local images directly to Notion. No image hosting service or server is required.

> Early development. Supports one-to-one note associations and manual review of Notion edits. Each Apply writes only the selected change to the note after human approval.

## Install and publish a note

1. Install Node.js 24 or later and run `npm ci` followed by `npm run build`.
2. Create `<vault>/.obsidian/plugins/notion-note-publisher/`.
3. Copy `dist/main.js` and `manifest.json` into that directory.
4. Reload Obsidian and enable **Notion Note Publisher** in Community plugins.
5. Create a [Notion internal integration](https://www.notion.so/profile/integrations) with read, insert, and update content capabilities.
6. Open an ordinary Notion page and add the integration under **Connections**.
7. Enter the integration token and parent page URL in the plugin settings. Click **测试连接**.
8. Open a Markdown note and run **发布当前笔记到 Notion** from the command palette, or right-click the note and select **发布到 Notion**.

The first publish creates a private Notion page under the selected parent. Later publishes update that same page after approval. Publishing does not enable public web sharing. To associate an existing page, run **关联当前笔记到 Notion 页面** instead.

## Supported content

Headings, rich text, lists, tasks, quotes, code, GFM tables, dividers, and images are converted to native Notion blocks by walking a unified/remark Markdown AST.

Prose `->` becomes `→` in headings, paragraphs, list items, table cells, link labels, and image captions. Inline code, fenced code, and link destinations retain their original characters. An autolink whose label equals its URL also stays unchanged. HTML `<br>` tags inside paragraphs become line breaks; other HTML remains literal text.

Obsidian callouts (`> [!note]`, `> [!warning] Custom title`) become native Notion callouts. Formatted titles, body blocks, nested lists, and images are retained. Warning, danger, tip, success, and question types have distinct icons and colors; other types use a note style. The `+` and `-` fold markers are accepted, but callouts always display expanded. Ordinary quotes put their first paragraph directly in the quote block and retain subsequent blocks as children.

Layout limits: headings deeper than level 3 become heading 3. Table alignment and custom ordered-list starting numbers are not retained. Footnotes use text labels rather than linked footnotes. Math, Obsidian highlights (`==text==`), internal wiki links, custom HTML layouts, columns, and toggle headings have no native conversion. These limitations belong to this converter; supported Notion API blocks are documented in the [Notion block reference](https://developers.notion.com/reference/block).

Local images support Obsidian embeds (`![[image.png]]`, including aliases and width suffixes), Markdown images, relative paths, and reference-style images. Image tables become labelled blocks in row order because Notion table cells accept rich text only. Each cell retains its column heading and its images. Text-only tables remain native Notion tables. Images nested inside inline formatting are rejected with an error. The resolver uses Obsidian's link resolution relative to the source note. Repeated references to one file upload once per publish. HTTPS and HTTP images retain their external URL.

Each local image must be at most 5 MiB. PNG, JPEG, GIF, WebP, SVG, ICO, and HEIC MIME types are recognized; Notion may reject a format depending on its file policies. Unsupported files fail the publish rather than becoming missing images.

## Associate a note and review Notion edits

1. Open the Markdown note and run **关联当前笔记到 Notion 页面**.
2. Enter its existing Notion page URL and click **验证并关联**.
3. Use **拉取修改** in the note's top bar, or run **拉取 Notion 修改并审阅**.
4. Select a change. The Pierre `FileDiff` viewer shows local and Notion text side by side, with line numbers, minus and plus indicators, and character-level changes. Switch to a stacked view when preferred. Edit the proposed text below if needed.
5. Click **Apply 此处** to write that change immediately, or **Reject 此处** to keep local content.
6. Continue through the remaining changes. Applied and rejected changes leave the queue and appear in collapsed history. Each Apply has its own backup.

Closing the review saves its draft and decisions. The next pull resumes it. Apply uses the captured remote snapshot and checks the complete local document before writing. It does not contact Notion on each click. Pull again to see newer remote edits. If the local document changed, regenerate the diff; already applied changes stay in the note. Local YAML frontmatter is preserved.

The top bar is plugin UI in both editing and reading views. It does not add a link or an ID to Markdown. Associations live in `data.json`, follow file and folder renames within Obsidian, and reject a second note for the same page. Legacy `notion-publisher-id` associations migrate without editing existing frontmatter. Renames performed while the plugin is disabled are not tracked.

Pull snapshots, drafts, decisions, and backups are stored under the plugin's `history/` directory. These are snapshots collected by this plugin, not Notion's complete edit history.

The diff model compares Markdown content units: paragraphs, headings, individual list items, code blocks, and tables. Equivalent Markdown formatting does not become a change. Unchanged units retain their original source text. Changes have stable IDs and independent pending, applied, or rejected states. Positions of remaining changes are adjusted after each Apply, so changes can be reviewed out of order.

The first pull has no historical baseline. It compares Notion with a local publish projection to filter known conversions, such as deep headings and expanded image tables, then maps changes back onto the original Markdown. Subsequent pulls compare the previous remote snapshot with the latest remote content, then project those changes through the paired local baseline. Local-only edits are retained. Overlapping edits become conflicts with the previous remote text shown for reference. Conflicts require a person to edit or explicitly apply their chosen result.

Once all changes have a decision, the plugin saves the paired local and remote baseline. Rejected remote changes do not reappear unless Notion edits that content again. Each Apply records a write-ahead journal before updating the note; reopening a review recovers a write that completed before its decision checkpoint was saved.

Internal Notion images are downloaded and matched against the note's local images by SHA-256. Matching images retain local embeds. New images are staged under the plugin's `staged/` directory and copied into `Notion attachments/<page-id>/` only when referenced in an approved result. Temporary signed image URLs are never written into the note.

Pull conversion supports paragraphs, headings, nested lists, tasks, quotes, callouts, toggles, code, tables, equations, bookmarks, and images. Callouts use a generic note style; toggles become expanded text. Notion colors and layouts do not round-trip. Unsupported block types stop the pull rather than silently dropping content.

## Publishing behavior

First publishing an unassociated note creates and saves its page association before writing blocks. If writing fails, the association is retained so a retry cannot create another page. Open the partial page and review it before retrying.

Publishing an associated note updates the same page. First review its current remote content to establish a baseline. Later publishes require approval and refuse to overwrite remote changes since the last baseline. Local images upload as before, and YAML frontmatter is excluded from publishing.

Updates append the complete new body before archiving old blocks. An append failure leaves old content intact and may leave part of the new body. A failure during archiving may leave duplicate content. Errors include the page URL for inspection. The API has no transaction spanning these requests, so concurrent editing during publishing is not supported. The plugin retries explicit rate-limit responses but does not blindly retry ambiguous network failures.

## Privacy

The integration token and page associations are stored in the plugin's `data.json` inside the vault. The token is stored in plaintext. Exclude that file from Git and avoid sharing it. Vault synchronization may copy it to your other devices.

The plugin history directory contains local and remote note snapshots, drafts, and backups. Staged images are also stored inside the plugin directory. These files can be copied by vault synchronization.

The plugin sends selected note content and referenced local images to `https://api.notion.com`. It does not contact an analytics service or an image host. Remote images remain remote references and can be fetched by Notion. YAML frontmatter is removed from the published body.

The first version has no database-property mapping, automatic synchronization, automatic publishing, note-embed expansion, Mermaid rendering, or Excalidraw rendering. Markdown extensions outside the supported syntax are not guaranteed to preserve their Obsidian appearance. Multi-device concurrent publishing is not supported.

## Develop

```sh
npm ci
npm run check
npm run dev
```

The stack is TypeScript 7 and Vite+ for build and Vitest. The output is a CommonJS `dist/main.js` with Obsidian externalized. Network I/O uses Obsidian `requestUrl`, including binary multipart uploads, to avoid renderer CORS restrictions.

`src/markdown.ts` resolves Markdown and image embeds. `src/notion.ts` handles Notion HTTP and uploads. `src/publish.ts` creates or updates associated pages. `src/pull.ts` converts remote blocks into Markdown. `src/sync-state.ts` validates associations and review snapshots. `src/review-model.ts` owns semantic diff, three-way range projection, conflicts, and per-change decisions. `src/diff-view.ts` integrates `@pierre/diffs` for display; rendering never applies a change. Pierre themes and runtime code are bundled into the single plugin file for offline use. `src/main.ts` integrates Obsidian commands and settings.

Tests cover Markdown conversion, uploads, pagination, one-to-one associations, stable-page updates, stale revisions, and failure handling. A smoke check loads the actual CommonJS bundle and exercises publishing, the virtual header, draft persistence, immediate per-change Apply, Reject, backups, local-edit protection, crash recovery, and renames. Obsidian and HTTP boundaries in CI are simulated. The opt-in live check below verifies a real workspace separately.

## License

MIT. See [LICENSE](LICENSE).

## Verify a live pull without approving it

Install the current build, associate a test note with its Notion page, and run **拉取 Notion 修改并审阅**. Leave the review open and unapproved. Run:

```sh
node tests/live-pull.mjs /path/to/vault 'Note.md' notion-page-id
```

This read-only check verifies the one-to-one mapping, visible header and review, unchanged original note, pending changes, editable proposal, and local image references. It does not publish, approve, or modify the note. Tests of writeback and publishing use a simulated Obsidian and HTTP boundary in `npm run smoke`.
