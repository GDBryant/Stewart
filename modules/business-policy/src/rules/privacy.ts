import type { Rule } from "../types.js";

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/;
const CARD = /(?<![\w.-])[3-6](?:[ -]?\d){12,18}(?![\w-])/g;
const IBAN = /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b/g;
const PHONE_INTL = /(?<![\w.])\+\d{1,3}[ .-]?\(?\d{1,4}\)?(?:[ .-]?\d{2,4}){2,4}(?![\w])/g;
const PHONE_LOCAL = /(?<![\w.-])\(?\d{3}\)?[ .-]\d{3}[ .-]\d{4}(?![\w-])/g;
const SSN = /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/;
const ID13 = /(?<!\d)\d{13}(?!\d)/g;

export function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return digits.length > 0 && sum % 10 === 0;
}

export function ibanValid(raw: string): boolean {
  const s = raw.replace(/ /g, "");
  if (s.length < 15 || s.length > 34) return false;
  const moved = s.slice(4) + s.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = /\d/.test(ch) ? ch : String(ch.charCodeAt(0) - 55);
    for (const c of v) rem = (rem * 10 + Number(c)) % 97;
  }
  return rem === 1;
}

function some(text: string, re: RegExp, ok: (m: string) => boolean): boolean {
  for (const m of text.matchAll(re)) if (ok(m[0])) return true;
  return false;
}

function cardOk(m: string): boolean {
  const d = m.replace(/\D/g, "");
  return d.length >= 13 && d.length <= 19 && luhn(d);
}

function phoneOk(m: string): boolean {
  const n = m.replace(/\D/g, "").length;
  return n >= 9 && n <= 15;
}

/** South African style ID: YYMMDD + 7 digits with a Luhn check. */
function id13Ok(m: string): boolean {
  const mm = Number(m.slice(2, 4));
  const dd = Number(m.slice(4, 6));
  return mm >= 1 && mm <= 12 && dd >= 1 && dd <= 31 && luhn(m);
}

function scan(text: string): string[] {
  const hits: string[] = [];
  if (EMAIL.test(text)) hits.push("email address");
  if (some(text, CARD, cardOk)) hits.push("payment card number");
  if (some(text, IBAN, ibanValid)) hits.push("IBAN");
  if (some(text, PHONE_INTL, phoneOk) || some(text, PHONE_LOCAL, phoneOk)) hits.push("phone number");
  if (SSN.test(text) || some(text, ID13, id13Ok)) hits.push("national ID number");
  return hits;
}

export const privacy: Rule = {
  id: "privacy",
  describe: "Email addresses, phone numbers, national ID numbers, payment cards, IBANs.",
  scan,
};
