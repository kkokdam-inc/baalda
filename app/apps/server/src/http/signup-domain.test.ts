import { describe, expect, it } from "vitest";
import { signupAllowed } from "./signup-domain.js";

describe("signupAllowed", () => {
  it("keeps upstream behaviour when unset", () => {
    expect(signupAllowed({ email: "a@gmail.com" }, undefined)).toBe(true);
    expect(signupAllowed({ email: "a@gmail.com" }, "")).toBe(true);
  });
  it("allows only listed domains", () => {
    expect(signupAllowed({ email: "ceo@kkokdam.com" }, "kkokdam.com")).toBe(true);
    expect(signupAllowed({ email: "CEO@KKOKDAM.COM" }, "kkokdam.com")).toBe(true);
    expect(signupAllowed({ email: "x@evil.com" }, "kkokdam.com")).toBe(false);
    expect(signupAllowed({ email: "x@kkokdam.com.evil.com" }, "kkokdam.com")).toBe(false);
    expect(signupAllowed({}, "kkokdam.com")).toBe(false);
    expect(signupAllowed(null, "kkokdam.com")).toBe(false);
  });
});
