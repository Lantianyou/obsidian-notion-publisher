import { z } from "zod";
import { mappingSchema } from "./publish";
import { actionSchema, sessionSchema } from "./review-model";
export { revision } from "./pull";

export const bindingSchema = mappingSchema.extend({
  baseline: z.object({ local: z.string(), remote: z.string(), revision: z.string() }).optional(),
  pending: z.string().optional(),
});
export type Binding = z.infer<typeof bindingSchema>;
export const reviewSchema = z.object({
  version: z.literal(3),
  page: z.string().uuid(),
  capturedAt: z.string(),
  local: z.string(),
  remote: z.string(),
  revision: z.string(),
  session: sessionSchema,
  drafts: z.record(z.string(), z.string()),
  journal: z.object({ action: actionSchema, before: z.string(), after: z.string() }).optional(),
  images: z.array(z.object({ staged: z.string(), target: z.string() })),
});
export type Review = z.infer<typeof reviewSchema>;
export function assertUnique(bindings: Record<string, Binding>, path: string, page: string) {
  const owner = Object.entries(bindings).find(
    ([other, value]) => other !== path && value.page === page,
  );
  if (owner) throw new Error(`该 Notion 页面已关联到 ${owner[0]}，一个页面只能关联一篇笔记。`);
}
export function moveBindings(bindings: Record<string, Binding>, oldPath: string, newPath: string) {
  for (const path of Object.keys(bindings)) {
    if (path === oldPath || path.startsWith(`${oldPath}/`)) {
      const value = bindings[path];
      if (value) bindings[newPath + path.slice(oldPath.length)] = value;
      delete bindings[path];
    }
  }
}
