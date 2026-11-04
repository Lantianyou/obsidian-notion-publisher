import { expect, it } from "vite-plus/test";
import { Notion, pageId, type HttpRequest } from "../src/notion";
const id = "11111111-1111-4111-8111-111111111111";
it("parses Notion URLs and IDs", () => {
  expect(pageId(`https://www.notion.so/Hello-${id.replaceAll("-", "")}?pvs=4`)).toBe(id);
  expect(pageId(id)).toBe(id);
  expect(() => pageId("bad")).toThrow();
});
it("uploads exact binary bytes in multipart to the official API", async () => {
  const requests: HttpRequest[] = [];
  const api = new Notion("test-token", async (request) => {
    requests.push(request);
    return {
      status: 200,
      headers: {},
      body: requests.length === 1 ? { id } : { id, status: "uploaded" },
    };
  });
  expect(await api.upload("图片.png", "image/png", new Uint8Array([0, 128, 255]).buffer)).toBe(id);
  const sent = requests[1];
  expect(sent?.url).toBe(`https://api.notion.com/v1/file_uploads/${id}/send`);
  expect(sent?.headers["Content-Type"]).toContain("boundary=");
  if (!(sent?.body instanceof ArrayBuffer)) throw new Error("expected binary");
  const request = new Request(sent.url, {
    method: "POST",
    headers: { "Content-Type": sent.headers["Content-Type"] ?? "" },
    body: sent.body,
  });
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new Error("expected file");
  expect(file.name).toBe("图片.png");
  expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([0, 128, 255]);
});
it("retries 429 with Retry-After but never blindly retries ambiguous writes", async () => {
  let calls = 0;
  const waits: number[] = [];
  const api = new Notion(
    "token",
    async () => {
      calls++;
      return calls === 1
        ? { status: 429, headers: { "Retry-After": "2" }, body: {} }
        : { status: 200, headers: {}, body: { id } };
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  await api.request("GET", "/users/me");
  expect(waits).toEqual([2000]);
  expect(calls).toBe(2);
  const failed = new Notion("token", async () => {
    throw new Error("network");
  });
  await expect(failed.request("POST", "/pages", {})).rejects.toThrow("network");
});

it("cleans up using the 2026-03-11 in_trash field and skips already trashed blocks", async () => {
  for (const inTrash of [false, true]) {
    const methods: string[] = [];
    const api = new Notion("token", async (request) => {
      methods.push(request.method);
      return { status: 200, headers: {}, body: { id, in_trash: inTrash } };
    });
    await api.archive(id);
    expect(methods).toEqual(inTrash ? ["GET"] : ["GET", "DELETE"]);
  }
});
