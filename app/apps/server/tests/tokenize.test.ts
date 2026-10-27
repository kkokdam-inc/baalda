import { describe, expect, it } from "vitest";
import { cosineSimilarity, embed, tokenize } from "../src/index/embedder.js";

describe("tokenize", () => {
  it("keeps Hangul words so Korean queries can match", () => {
    expect(tokenize("발주서 상세 처리 기준")).toEqual(["발주서", "상세", "처리", "기준"]);
    expect(tokenize("월결산 2026-10 Close_v2")).toEqual(["월결산", "2026", "10", "close_v2"]);
  });

  it("gives Korean text a non-zero vector that matches the same words", () => {
    const doc = embed("디자인 기준: 흰 여백과 골드 포인트");
    expect(cosineSimilarity(embed("디자인 기준"), doc)).toBeGreaterThan(0);
    expect(cosineSimilarity(embed("결산 마감"), doc)).toBe(0);
  });
});
