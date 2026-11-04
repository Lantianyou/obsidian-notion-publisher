# Notion Note Publisher

Publish one Obsidian note and its local images directly to Notion. No image hosting service or server is required.

> Early development. Verified on 2026-11-04 in Obsidian 1.15.0 against a live Notion workspace: image upload and byte-for-byte download, same-page updates after a note rename, cleanup recovery, preservation of content outside the managed body, and missing-image rejection.

## Install and publish a note

1. Install Node.js 24 or later and run `npm ci` followed by `npm run build`.
2. Create `<vault>/.obsidian/plugins/notion-note-publisher/`.
3. Copy `dist/main.js` and `manifest.json` into that directory.
4. Reload Obsidian and enable **Notion Note Publisher** in Community plugins.
5. Create a [Notion internal integration](https://www.notion.so/profile/integrations) with read, insert, and update content capabilities.
6. Open an ordinary Notion page and add the integration under **Connections**.
7. Enter the integration token and parent page URL in the plugin settings. Click **测试连接**.
8. Open a Markdown note and run **发布当前笔记到 Notion** from the command palette, or right-click the note and select **发布到 Notion**.

The plugin opens the resulting Notion page. Running the command again updates that page. Publishing creates a private page under the selected parent; it does not enable public web sharing.

## Supported content

Headings, rich text, lists, tasks, quotes, code, GFM tables, dividers, and images are converted to native Notion blocks by walking a unified/remark Markdown AST.

Local images support Obsidian embeds (`![[image.png]]`, including aliases and width suffixes), Markdown images, relative paths, and reference-style images. Images inside table cells or inline formatting are rejected with an error. The resolver uses Obsidian's link resolution relative to the source note. Repeated references to one file upload once per publish. HTTPS and HTTP images retain their external URL.

Each local image must be at most 5 MiB. PNG, JPEG, GIF, WebP, SVG, ICO, and HEIC MIME types are recognized; Notion may reject a format depending on its file policies. Unsupported files fail the publish rather than becoming missing images.

## Update and recovery behavior

The plugin adds `notion-publisher-id` to the note's frontmatter. This identifier links the note to its page after a rename or move. Do not copy this identifier into another independent note; remove it from a duplicated note before publishing.

Published content lives in an expandable **笔记正文 · Obsidian** block. Each update creates a new container, writes its content, saves the new mapping, and archives the previous container. Content outside these containers is preserved. Edit the managed body in Obsidian: edits made inside its Notion container are replaced on the next publish.

If writing fails, the previous body stays available. An incomplete container can remain visible until the next publish, which removes it before retrying. Saved cleanup work is retried after an interrupted run.

This is not an atomic transaction across Notion and local disk. A network timeout immediately after page or container creation can leave an orphan object, because the API does not provide an idempotency key for these writes. The plugin retries explicit rate-limit responses, but does not blindly retry ambiguous network failures. Inspect the target page before retrying such a failure.

## Privacy

The integration token, page mappings, and recovery state are stored in the plugin's `data.json` inside the vault. The token is stored in plaintext. Exclude that file from Git and avoid sharing it. Vault synchronization may copy it to your other devices.

The plugin sends selected note content and referenced local images to `https://api.notion.com`. It does not contact an analytics service or an image host. Remote images remain remote references and can be fetched by Notion. YAML frontmatter is removed from the published body.

The first version has no database-property mapping, bidirectional sync, automatic publishing, note-embed expansion, Mermaid rendering, or Excalidraw rendering. Markdown extensions outside the supported syntax are not guaranteed to preserve their Obsidian appearance. Multi-device concurrent publishing is not supported.

## Develop

```sh
npm ci
npm run check
npm run dev
```

The stack is TypeScript 7 and Vite+ for build and Vitest. The output is a CommonJS `dist/main.js` with Obsidian externalized. Network I/O uses Obsidian `requestUrl`, including binary multipart uploads, to avoid renderer CORS restrictions.

`src/markdown.ts` resolves Markdown and image embeds. `src/notion.ts` handles Notion HTTP and uploads. `src/publish.ts` owns staged updates and recovery. `src/main.ts` integrates Obsidian commands and settings.

Tests cover real Markdown conversion, binary multipart parsing, rate limits, batching, and preservation of the previous generation after a failed write. A separate smoke check loads the actual CommonJS bundle in a DOM environment and exercises the Obsidian command through two publishes. Obsidian and HTTP boundaries in CI are simulated. The opt-in live check below verifies a real workspace separately.

## License

MIT. See [LICENSE](LICENSE).

## Verify against a live workspace

Use a dedicated test note and parent page. Copy `tests/fixtures/publish.md` and `tests/fixtures/测试图片.png` into one folder in your vault, configure the plugin, and publish the note once. The following script reads the token from the local plugin settings without printing it. It adds a test paragraph outside the managed body to check preservation.

```sh
node tests/live-notion.mjs first /path/to/vault/.obsidian/plugins/notion-note-publisher/data.json /path/to/vault/test/测试图片.png
```

Rename the test note, append `SECOND_PUBLISH_VERIFIED` to its body, and publish it again. Run the second check with the same paths:

```sh
node tests/live-notion.mjs second /path/to/vault/.obsidian/plugins/notion-note-publisher/data.json /path/to/vault/test/测试图片.png
```

This check expects an installation with one published test note. It downloads both image blocks, compares their bytes to the vault image, checks representative Markdown blocks, and confirms that the old container is trashed while the external paragraph survives. Reports and recovery identifiers are stored in ignored `.local-live/`, outside the build output.
