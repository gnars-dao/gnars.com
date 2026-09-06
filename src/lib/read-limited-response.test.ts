import { describe, expect, it } from "vitest";
import { readLimitedResponse } from "./read-limited-response";

describe("bounded response reads", () => {
  it("decodes UTF-8 split between chunks", async () => {
    const bytes = new TextEncoder().encode("caf\u00e9");
    const body = new ReadableStream({
      start(controller) {
        controller.enqueue(bytes.slice(0, 4));
        controller.enqueue(bytes.slice(4));
        controller.close();
      },
    });
    expect(await readLimitedResponse(new Response(body), 5)).toBe("caf\u00e9");
  });
  it("rejects chunked bodies exceeding the byte limit", async () => {
    await expect(readLimitedResponse(new Response("12345"), 4)).rejects.toThrow("too large");
  });
  it("rejects oversized declared length before reading", async () => {
    await expect(
      readLimitedResponse(
        new Response("ok", {
          headers: { "content-length": "1000000" },
        }),
        4,
      ),
    ).rejects.toThrow("too large");
  });
});
