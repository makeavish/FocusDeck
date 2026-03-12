import { describe, expect, it } from "vitest";
import { normalizeXStatusPermalink, resolveBestXPermalink } from "@/adapters/x-adapter";

describe("x-adapter permalink resolution", () => {
  it("normalizes photo and video detail URLs back to the post permalink", () => {
    expect(normalizeXStatusPermalink("https://x.com/djfarrelly/status/1899930306353080500/photo/1")).toBe(
      "https://x.com/djfarrelly/status/1899930306353080500"
    );
    expect(normalizeXStatusPermalink("https://twitter.com/djfarrelly/status/1899930306353080500/video/1")).toBe(
      "https://twitter.com/djfarrelly/status/1899930306353080500"
    );
  });

  it("prefers the status permalink over other internal X links", () => {
    const permalink = resolveBestXPermalink([
      {
        url: "https://x.com/djfarrelly"
      },
      {
        url: "https://x.com/djfarrelly/status/1899930306353080500",
        hasTime: true,
        inUserNameBlock: true
      },
      {
        url: "https://x.com/i/articles/1234567890"
      }
    ]);

    expect(permalink).toBe("https://x.com/djfarrelly/status/1899930306353080500");
  });

  it("accepts i/status links when that is the only tweet permalink candidate", () => {
    const permalink = resolveBestXPermalink([
      {
        url: "https://x.com/explore"
      },
      {
        url: "https://x.com/i/status/1899930306353080500",
        hasTime: true
      }
    ]);

    expect(permalink).toBe("https://x.com/i/status/1899930306353080500");
  });
});
