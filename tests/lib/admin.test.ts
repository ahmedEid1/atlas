import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  env: { ADMIN_EMAILS: "" },
}));

import { env } from "@/lib/env";
import { adminEmails, isAdminEmail } from "@/lib/admin";

beforeEach(() => {
  (env as { ADMIN_EMAILS: string }).ADMIN_EMAILS = "";
});

describe("adminEmails", () => {
  it("returns empty Set when ADMIN_EMAILS is unset", () => {
    expect(adminEmails().size).toBe(0);
  });

  it("parses a comma-separated list, lowercases + trims", () => {
    (env as { ADMIN_EMAILS: string }).ADMIN_EMAILS = " Ops@example.com , owner@thoth.app ";
    const s = adminEmails();
    expect(s.has("ops@example.com")).toBe(true);
    expect(s.has("owner@thoth.app")).toBe(true);
    expect(s.size).toBe(2);
  });

  it("ignores empty entries from trailing commas", () => {
    (env as { ADMIN_EMAILS: string }).ADMIN_EMAILS = "a@b.c,,";
    expect(adminEmails().size).toBe(1);
  });
});

describe("isAdminEmail", () => {
  it("returns false when email is null/undefined", () => {
    expect(isAdminEmail(null)).toBe(false);
    expect(isAdminEmail(undefined)).toBe(false);
  });

  it("returns false when ADMIN_EMAILS is unset (no admins by default)", () => {
    expect(isAdminEmail("anyone@example.com")).toBe(false);
  });

  it("returns true for an exact match", () => {
    (env as { ADMIN_EMAILS: string }).ADMIN_EMAILS = "ops@example.com";
    expect(isAdminEmail("ops@example.com")).toBe(true);
  });

  it("is case-insensitive on both sides", () => {
    (env as { ADMIN_EMAILS: string }).ADMIN_EMAILS = "Ops@Example.com";
    expect(isAdminEmail("ops@example.com")).toBe(true);
    expect(isAdminEmail("OPS@EXAMPLE.COM")).toBe(true);
  });

  it("returns false for a non-listed email even when others are admins", () => {
    (env as { ADMIN_EMAILS: string }).ADMIN_EMAILS = "ops@example.com,owner@thoth.app";
    expect(isAdminEmail("guest@example.com")).toBe(false);
  });
});
