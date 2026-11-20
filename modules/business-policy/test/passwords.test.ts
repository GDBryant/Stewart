import { describe, expect, it } from "vitest";
import { passwords } from "../src/rules/passwords.js";

const hit = (t: string) => passwords.scan(t).length > 0;

describe("passwords rule", () => {
  it.each([
    "password=hunter2",
    "password: hunter2",
    'password: "correcthorse"',
    "password=correcthorse",
    'DB_PASSWORD: "s3cr3tValue"',
    '{"api_key": "abcd1234efgh"}',
    "export API_TOKEN=abcdef123456",
    "Authorization: Bearer abcdefgh12345678",
    "-----BEGIN RSA PRIVATE KEY-----",
    "postgres://admin:p4ssw0rd@db.local/app",
    "key AKIAIOSFODNN7EXAMPLE here",
    `token ghp_${"a".repeat(36)}`,
    `sk-${"a1".repeat(12)}`,
    "eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijkl",
    "xoxb-1234567890-abcdef",
    `AIza${"a".repeat(35)}`,
    "Bearer abcdefghijklmnopqrstuvwxyz",
  ])("flags %s", (t) => expect(hit(t)).toBe(true));

  it.each([
    "password=<your-password>",
    "password=changeme",
    "password=***",
    "password=${DB_PASSWORD}",
    "password: string",
    "token = getToken()",
    "password = process.env.DB_PASSWORD",
    "Please reset your password in settings",
    "the token count is high",
    "tokens: numbered filler lines",
    "password: required",
    "https://example.com/path",
    "postgres://localhost/app",
    "",
  ])("passes %s", (t) => expect(hit(t)).toBe(false));

  it("never returns the matched text", () => {
    const out = passwords.scan("password=hunter2 and AKIAIOSFODNN7EXAMPLE").join("|");
    expect(out).not.toContain("hunter2");
    expect(out).not.toContain("AKIA");
  });
});
