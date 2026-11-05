import { expect, it } from "vite-plus/test";
import { createSession, decide, complete, type Session } from "../src/review-model";
function apply(session: Session, index: number, text?: string) {
  const hunk = session.hunks[index];
  if (!hunk) throw new Error("Missing hunk");
  return decide(session, { kind: "apply", id: hunk.id, text: text ?? hunk.proposed, at: "now" });
}
it("compares Markdown meaning and keeps local formatting when remote content is equivalent", () => {
  const local =
    "---\ntags: [x]\n---\n## Heading\n\n- one\n\t- **two**\n\nText -> value [link](https://example.com)\n";
  const remote =
    "## Heading\n\n- one\n    - **two**\n\nText → value [link](<https://example.com>)\n";
  const session = createSession({ local, remote });
  expect(session.hunks).toHaveLength(0);
  expect(session.document).toBe(local);
});
it("splits adjacent changed paragraphs into separate decisions", () => {
  const session = createSession({
    local: "A\n\nB\n\nC\n",
    remote: "Changed A\n\nChanged B\n\nC\n",
  });
  expect(session.hunks).toHaveLength(2);
  expect(session.hunks[0]?.before).toBe("A\n\n");
  expect(session.hunks[1]?.before).toBe("B\n\n");
});
it("applies later hunks first, rebases remaining positions, and leaves rejected content intact", () => {
  let session = createSession({
    local: "A\n\nB\n\nC\n",
    remote: "A long change\n\nB changed\n\nC changed\n",
  });
  session = apply(session, 2);
  session = apply(session, 0);
  const second = session.hunks[1];
  if (!second) throw new Error("missing");
  session = decide(session, { kind: "reject", id: second.id, at: "now" });
  expect(session.document).toBe("A long change\n\nB\n\nC changed\n");
  expect(complete(session)).toBe(true);
});
it("handles insertions and deletions without replacing untouched blocks or YAML", () => {
  let session = createSession({
    local: "---\ntag: x\n---\nKeep\n\nDelete\n\nEnd\n",
    remote: "Insert\n\nKeep\n\nEnd\n",
  });
  for (let i = 0; i < session.hunks.length; i++) session = apply(session, i);
  expect(session.document).toBe("---\ntag: x\n---\nInsert\n\nKeep\n\nEnd\n");
});
it("shows only new remote edits when local-only edits exist since a baseline", () => {
  const baseline = { local: "A\n\nB\n\nC\n", remote: "A\n\nB\n\nC\n" };
  const session = createSession({
    baseline,
    local: "Local A\n\nB\n\nC\n",
    remote: "A\n\nB\n\nRemote C\n",
  });
  expect(session.hunks).toHaveLength(1);
  expect(session.hunks[0]?.kind).toBe("remote");
  expect(apply(session, 0).document).toBe("Local A\n\nB\n\nRemote C\n");
});
it("does not consume an adjacent local-only edit", () => {
  const baseline = { local: "A\n\nB\n\nC\n", remote: "A\n\nB\n\nC\n" };
  const session = createSession({
    baseline,
    local: "A\n\nLocal B\n\nC\n",
    remote: "Remote A\n\nB\n\nC\n",
  });
  expect(session.hunks[0]?.before).toBe("A\n\n");
  expect(session.hunks[0]?.kind).toBe("remote");
  expect(apply(session, 0).document).toBe("Remote A\n\nLocal B\n\nC\n");
});
it("marks overlapping local and remote edits as a conflict and accepts a human resolution", () => {
  const baseline = { local: "A\n\nB\n", remote: "A\n\nB\n" };
  const session = createSession({ baseline, local: "Local A\n\nB\n", remote: "Remote A\n\nB\n" });
  expect(session.hunks[0]?.kind).toBe("conflict");
  expect(session.hunks[0]?.base).toBe("A\n\n");
  expect(apply(session, 0, "Human merged A\n\n").document).toBe("Human merged A\n\nB\n");
});
it("does not propose already applied remote changes again after an interrupted session", () => {
  const baseline = { local: "A\n\nB\n", remote: "A\n\nB\n" };
  const session = createSession({
    baseline,
    local: "Remote A\n\nB\n",
    remote: "Remote A\n\nRemote B\n",
  });
  expect(session.hunks).toHaveLength(1);
  expect(session.hunks[0]?.before).toBe("B\n");
});
it("records rejection in the paired baseline so it is not proposed by the next pull", () => {
  const local = "A\n\nB\n";
  const remote = "Remote A\n\nB\n";
  const next = createSession({ local, remote, baseline: { local, remote } });
  expect(next.hunks).toHaveLength(0);
  const changedAgain = createSession({
    local,
    remote: "Another remote A\n\nB\n",
    baseline: { local, remote },
  });
  expect(changedAgain.hunks[0]?.kind).toBe("conflict");
});
it("keeps a merged conflict limited to the rewritten local content", () => {
  const baseline = { local: "A\n\nB\n\nUntouched\n", remote: "A\n\nB\n\nUntouched\n" };
  const session = createSession({
    baseline,
    local: "Local combined A and B\n\nUntouched\n",
    remote: "Remote A\n\nRemote B\n\nUntouched\n",
  });
  expect(session.hunks).toHaveLength(1);
  expect(session.hunks[0]?.before).not.toContain("Untouched");
  expect(session.hunks[0]?.proposed).not.toContain("Untouched");
  expect(session.hunks[0]?.kind).toBe("conflict");
});
it("reject and repeat Apply cannot change the document", () => {
  const original = createSession({ local: "A\n", remote: "B\n" });
  const hunk = original.hunks[0];
  if (!hunk) throw new Error("missing");
  const rejected = decide(original, { kind: "reject", id: hunk.id, at: "now" });
  expect(rejected.document).toBe(original.document);
  expect(() => apply(rejected, 0)).toThrow();
});
it("applies arbitrary insert, delete, and replace combinations in reverse order without overlap", () => {
  let seed = 17;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  for (let run = 0; run < 100; run++) {
    const original = Array.from({ length: 12 }, (_, index) => `Paragraph ${index}`);
    const changed = original.flatMap((text, index) => {
      const variant = next() % 4;
      return variant === 0
        ? []
        : variant === 1
          ? [`Insert ${run}-${index}`, text]
          : variant === 2
            ? [`Changed ${run}-${index}`]
            : [text];
    });
    const local = original.join("\n\n") + "\n";
    const remote = changed.join("\n\n") + (changed.length ? "\n" : "");
    let session = createSession({ local, remote, baseline: { local, remote: local } });
    for (let index = session.hunks.length - 1; index >= 0; index--) session = apply(session, index);
    expect(createSession({ local: session.document, remote }).hunks, `case ${run}`).toHaveLength(0);
  }
});
it("keeps the unchanged half when a remote edit touches a locally combined paragraph", () => {
  const baseline = { local: "A\n\nB\n\nKeep\n", remote: "A\n\nB\n\nKeep\n" };
  const session = createSession({
    baseline,
    local: "Combined A and B\n\nKeep\n",
    remote: "Remote A\n\nB\n\nKeep\n",
  });
  expect(session.hunks).toHaveLength(1);
  expect(session.hunks[0]?.proposed).toBe("Remote A\n\nB\n\n");
  expect(apply(session, 0).document).toBe("Remote A\n\nB\n\nKeep\n");
});
it("filters known publishing conversions on first alignment", () => {
  const local = "#### Deep heading\n\n| Image |\n| --- |\n| ![[local.png]] |\n\nKeep\n";
  const projection = "### Deep heading\n\n**Image**\n\n![[local.png]]\n\nKeep\n";
  expect(createSession({ local, remote: projection, projection }).hunks).toHaveLength(0);
  const session = createSession({
    local,
    remote: projection.replace("**Image**", "**New label**"),
    projection,
  });
  expect(session.hunks).toHaveLength(1);
  expect(session.hunks[0]?.before).toContain("| Image |");
  expect(session.hunks[0]?.before).not.toContain("Keep");
  expect(session.hunks[0]?.proposed).toContain("![[local.png]]");
  expect(session.hunks[0]?.proposed).not.toContain("Keep");
});
