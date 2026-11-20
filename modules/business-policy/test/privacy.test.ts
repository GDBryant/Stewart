import { describe, expect, it } from "vitest";
import { ibanValid, luhn, privacy } from "../src/rules/privacy.js";

const kinds = (t: string) => privacy.scan(t);

describe("privacy rule", () => {
  it.each([
    ["mail jane.doe@example.com now", "email address"],
    ["card 4111 1111 1111 1111", "payment card number"],
    ["card 5500-0000-0000-0004", "payment card number"],
    ["pay GB82 WEST 1234 5698 7654 32", "IBAN"],
    ["pay DE89370400440532013000", "IBAN"],
    ["call +27 82 123 4567", "phone number"],
    ["call (555) 123-4567", "phone number"],
    ["call 082 123 4567", "phone number"],
    ["ssn 123-45-6789", "national ID number"],
    ["id 8001015009087", "national ID number"],
  ])("flags %s", (t, kind) => expect(kinds(t)).toContain(kind));

  it.each([
    "version 1.2.3 and 10.0.0.1",
    "id 550e8400-e29b-41d4-a716-446655440000",
    "at file.ts:1234567",
    "ts 1731974400000",
    "card 4111 1111 1111 1112",
    "IBAN GB00 WEST 1234 5698 7654 32",
    "@types/node and @stewart/kernel",
    "sha 3a7bd3e2360a3d29eea436fcfb7e44c735d117c4",
    "ssn 000-12-3456",
    "plain prose with no data",
    "",
  ])("passes %s", (t) => expect(kinds(t)).toEqual([]));

  it("never returns the matched text", () => {
    expect(kinds("jane.doe@example.com 4111111111111111").join("|")).not.toMatch(/jane|4111/);
  });

  it("validators", () => {
    expect(luhn("4111111111111111")).toBe(true);
    expect(luhn("")).toBe(false);
    expect(ibanValid("GB82WEST12345698765432")).toBe(true);
    expect(ibanValid("GB82")).toBe(false);
    expect(ibanValid("GB00WEST12345698765432")).toBe(false);
  });
});
