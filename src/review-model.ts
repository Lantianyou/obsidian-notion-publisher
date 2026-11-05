import { diffArrays } from "diff";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import type { RootContent, Root, ListItem, Blockquote, List } from "mdast";
import { z } from "zod";
import { frontmatter } from "./pull";

const decisionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("pending") }),
  z.object({ kind: z.literal("applied"), text: z.string(), at: z.string() }),
  z.object({ kind: z.literal("rejected"), at: z.string() }),
]);
export const hunkSchema = z.object({
  id: z.string().uuid(),
  start: z.number().int().nonnegative(),
  before: z.string(),
  proposed: z.string(),
  section: z.string(),
  kind: z.enum(["initial", "remote", "conflict"]),
  // Present only when a real previous sync base exists.
  base: z.string().optional(),
  decision: decisionSchema,
});
export type Hunk = z.infer<typeof hunkSchema>;
export const sessionSchema = z.object({
  document: z.string(),
  hunks: z.array(hunkSchema),
});
export type Session = z.infer<typeof sessionSchema>;
export const actionSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("apply"), id: z.string().uuid(), text: z.string(), at: z.string() }),
  z.object({ kind: z.literal("reject"), id: z.string().uuid(), at: z.string() }),
]);
export type ReviewAction = z.infer<typeof actionSchema>;

type Atom = {
  start: number;
  end: number;
  key: string;
  shape: string;
  section: string;
  text: string;
};
type Edit = { start: number; end: number; insert: Atom[] };
const parser = unified().use(remarkParse).use(remarkGfm);

// Positions are used only to slice source text. Comparison uses Markdown meaning,
// so an untouched local block retains its exact formatting and whitespace.
function semantic(value: unknown, parentType = ""): unknown {
  if (Array.isArray(value)) return value.map((item) => semantic(item, parentType));
  if (!value || typeof value !== "object") return value;
  const record = z.record(z.string(), z.unknown()).parse(value);
  const type = typeof record.type === "string" ? record.type : parentType;
  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(record)) {
    if (["position", "data", "spread", "start"].includes(key)) continue;
    if (key === "value" && type === "text" && typeof item === "string") {
      result[key] = item.replace(/\s+/g, " ").replaceAll("->", "→");
    } else result[key] = semantic(item, type);
  }
  return result;
}
function label(node: RootContent): string {
  if ("value" in node && typeof node.value === "string") return node.value;
  return "children" in node
    ? node.children.map((child) => ("value" in child ? child.value : "")).join("")
    : node.type;
}
function atoms(source: string): Atom[] {
  const prefix = frontmatter(source).length;
  const body = source.slice(prefix);
  const tree = parser.parse(body);
  const leaves: { node: RootContent; context: string[]; section: string }[] = [];
  let section = "文档开头";
  function walk(parent: Root | List | ListItem | Blockquote, context: string[]) {
    for (const node of parent.children) {
      if (node.type === "heading") section = label(node);
      if (node.type === "list") walk(node, [...context, node.ordered ? "ordered" : "unordered"]);
      else if (node.type === "listItem")
        walk(node, [...context, `item:${String(node.checked ?? "plain")}`]);
      else if (node.type === "blockquote") walk(node, [...context, "quote"]);
      else leaves.push({ node, context, section });
    }
  }
  walk(tree, []);
  if (!leaves.length)
    return body
      ? [
          {
            start: prefix,
            end: source.length,
            key: JSON.stringify(body.trim()),
            shape: "empty",
            section,
            text: body,
          },
        ]
      : [];
  return leaves.map(({ node, context, section }, index) => {
    const offset = node.position?.start.offset;
    const next = leaves[index + 1]?.node.position?.start.offset;
    if (offset === undefined) throw new Error("Markdown 节点缺少位置。");
    const start = index === 0 ? prefix : prefix + body.lastIndexOf("\n", offset - 1) + 1;
    const end = next === undefined ? source.length : prefix + body.lastIndexOf("\n", next - 1) + 1;
    return {
      start,
      end,
      text: source.slice(start, end),
      section,
      shape: JSON.stringify([context, node.type]),
      key: JSON.stringify([context, semantic(node)]),
    };
  });
}
function edits(before: Atom[], after: Atom[]): Edit[] {
  const result: Edit[] = [];
  let index = 0;
  let active: Edit | undefined;
  const flush = () => {
    if (!active) return;
    const removed = before.slice(active.start, active.end);
    if (
      removed.length > 1 &&
      removed.length === active.insert.length &&
      removed.every((atom, i) => atom.shape === active?.insert[i]?.shape)
    ) {
      for (const [i, atom] of active.insert.entries())
        result.push({ start: active.start + i, end: active.start + i + 1, insert: [atom] });
    } else result.push(active);
    active = undefined;
  };
  for (const part of diffArrays(before, after, { comparator: (a, b) => a.key === b.key })) {
    if (!part.added && !part.removed) {
      flush();
      index += part.value.length;
    } else {
      active ??= { start: index, end: index, insert: [] };
      if (part.removed) {
        index += part.value.length;
        active.end = index;
      }
      if (part.added) active.insert.push(...part.value);
    }
  }
  flush();
  return result;
}
function overlaps(a: { start: number; end: number }, b: { start: number; end: number }) {
  if (a.start === a.end || b.start === b.end) return a.start <= b.end && b.start <= a.end;
  return a.start < b.end && b.start < a.end;
}
// Project a base range into another version. Ranges that touch edits expand to
// contain those edits and become conflicts; they are never silently overwritten.
function project(range: { start: number; end: number }, changes: Edit[]) {
  function boundary(position: number, side: "start" | "end") {
    let delta = 0;
    for (const change of changes) {
      if (position < change.start) break;
      if (position <= change.end) {
        if (change.start !== change.end) {
          if (position === change.start) return change.start + delta;
          if (position === change.end) return change.start + delta + change.insert.length;
        }
        return change.start + delta + (side === "end" ? change.insert.length : 0);
      }
      delta += change.insert.length - (change.end - change.start);
    }
    return position + delta;
  }
  return {
    start: boundary(range.start, "start"),
    end: boundary(range.end, "end"),
    conflict: changes.some((change) => overlaps(range, change)),
  };
}
function sliceTokens(tokens: Atom[], start: number, end: number) {
  return tokens
    .slice(start, end)
    .map((atom) => atom.text)
    .join("");
}

export function createSession(args: {
  local: string;
  remote: string;
  baseline?: { local: string; remote: string };
  projection?: string;
}): Session {
  const local = atoms(args.local);
  const remote = atoms(args.remote);
  const baseRemote = args.baseline
    ? atoms(args.baseline.remote)
    : args.projection !== undefined
      ? atoms(args.projection)
      : local;
  const baseLocal = args.baseline ? atoms(args.baseline.local) : local;
  const bridge = edits(baseRemote, baseLocal);
  const localEdits = edits(baseLocal, local);
  const inverseBridge = edits(baseLocal, baseRemote);
  const remoteEdits = edits(baseRemote, remote);
  const groups: {
    hunk: Hunk;
    remoteStart: number;
    remoteEnd: number;
    baseStart: number;
    baseEnd: number;
  }[] = [];
  function expanded(range: { start: number; end: number }, changes: Edit[]) {
    let next = { ...range };
    for (const change of changes)
      if (overlaps(next, change))
        next = { start: Math.min(next.start, change.start), end: Math.max(next.end, change.end) };
    return next;
  }
  for (const change of remoteEdits) {
    let range = { start: change.start, end: change.end };
    for (;;) {
      const bridgeRange = expanded(range, bridge);
      const localRange = expanded(project(bridgeRange, bridge), localEdits);
      const back = project(localRange, inverseBridge);
      const next = {
        start: Math.min(range.start, bridgeRange.start, back.start),
        end: Math.max(range.end, bridgeRange.end, back.end),
      };
      if (next.start === range.start && next.end === range.end) break;
      range = next;
    }
    const remoteRange = project(range, remoteEdits);
    const remoteStart = remoteRange.start;
    const remoteEnd = remoteRange.end;
    const bridged = project(range, bridge);
    const projected = project(bridged, localEdits);
    const before = sliceTokens(local, projected.start, projected.end);
    const proposed = sliceTokens(remote, remoteStart, remoteEnd);
    const localKeys = local.slice(projected.start, projected.end).map((atom) => atom.key);
    if (
      JSON.stringify(localKeys) ===
      JSON.stringify(remote.slice(remoteStart, remoteEnd).map((atom) => atom.key))
    )
      continue;
    const start = local[projected.start]?.start ?? args.local.length;
    groups.push({
      remoteStart,
      remoteEnd,
      baseStart: range.start,
      baseEnd: range.end,
      hunk: {
        id: crypto.randomUUID(),
        start,
        before,
        proposed,
        section: local[projected.start]?.section ?? change.insert[0]?.section ?? "文档末尾",
        kind: !args.baseline
          ? "initial"
          : bridged.conflict || projected.conflict
            ? "conflict"
            : "remote",
        ...(args.baseline ? { base: sliceTokens(baseRemote, range.start, range.end) } : {}),
        decision: { kind: "pending" },
      },
    });
  }
  // Merge remote changes that project onto one locally rewritten content unit.
  // The merged conflict contains that unit, never an unrelated document region.
  for (let index = 1; index < groups.length;) {
    const previous = groups[index - 1];
    const current = groups[index];
    if (!previous || !current) break;
    if (
      previous.hunk.start + previous.hunk.before.length > current.hunk.start ||
      previous.hunk.start === current.hunk.start
    ) {
      const start = Math.min(previous.hunk.start, current.hunk.start);
      const end = Math.max(
        previous.hunk.start + previous.hunk.before.length,
        current.hunk.start + current.hunk.before.length,
      );
      previous.remoteEnd = current.remoteEnd;
      previous.baseEnd = current.baseEnd;
      previous.hunk = {
        ...previous.hunk,
        start,
        before: args.local.slice(start, end),
        proposed: sliceTokens(remote, previous.remoteStart, previous.remoteEnd),
        kind: "conflict",
        ...(args.baseline
          ? { base: sliceTokens(baseRemote, previous.baseStart, previous.baseEnd) }
          : {}),
      };
      groups.splice(index, 1);
    } else index++;
  }
  return { document: args.local, hunks: groups.map((group) => group.hunk) };
}

export function decide(session: Session, action: ReviewAction): Session {
  const hunk = session.hunks.find((item) => item.id === action.id);
  if (!hunk || hunk.decision.kind !== "pending")
    throw new Error("这处修改已处理，请刷新审阅状态。");
  if (action.kind === "reject")
    return {
      ...session,
      hunks: session.hunks.map((item) =>
        item.id === hunk.id ? { ...item, decision: { kind: "rejected", at: action.at } } : item,
      ),
    };
  if (session.document.slice(hunk.start, hunk.start + hunk.before.length) !== hunk.before)
    throw new Error("修改位置与原文不一致，请重新拉取。");
  const delta = action.text.length - hunk.before.length;
  return {
    document:
      session.document.slice(0, hunk.start) +
      action.text +
      session.document.slice(hunk.start + hunk.before.length),
    hunks: session.hunks.map((item) =>
      item.id === hunk.id
        ? { ...item, decision: { kind: "applied", text: action.text, at: action.at } }
        : item.start >= hunk.start + hunk.before.length
          ? { ...item, start: item.start + delta }
          : item,
    ),
  };
}
export function complete(session: Session) {
  return session.hunks.every((hunk) => hunk.decision.kind !== "pending");
}
