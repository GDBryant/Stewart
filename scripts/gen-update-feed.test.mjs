import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { feedXml, xmlEscape, SEMVER } from "./gen-update-feed.mjs";

test("feed contains plugin id, release URL, version and since-build", () => {
  const xml = feedXml("2.0.1");
  assert.match(xml, /<plugin id="com\.adb\.stewart"/);
  assert.match(xml, /url="https:\/\/github\.com\/GDBryant\/Stewart\/releases\/download\/v2\.0\.1\/stewart-2\.0\.1\.zip"/);
  assert.match(xml, /version="2\.0\.1"/);
  assert.match(xml, /<idea-version since-build="261"\/>/);
  assert.match(xml, /<name>Stewart<\/name>/);
});

test("change notes are XML-escaped", () => {
  const xml = feedXml("2.0.1", { changeNotes: 'fix <b> & "quotes" \'' });
  assert.match(xml, /fix &lt;b&gt; &amp; &quot;quotes&quot; &apos;/);
  assert.doesNotMatch(xml, /<b>/);
  assert.equal(xmlEscape('<a href="x">&\''), "&lt;a href=&quot;x&quot;&gt;&amp;&apos;");
});

test("rejects malformed versions", () => {
  for (const bad of ["v2.0.1", "2.0", "x.y.z", "2.0.1 beta", ""]) {
    assert.throws(() => feedXml(bad), /malformed version/);
    assert.equal(SEMVER.test(bad), false, bad);
  }
  for (const good of ["2.0.1", "2.0.1-rc1", "10.20.30"]) assert.equal(SEMVER.test(good), true, good);
});

test("cli rejects missing and malformed args", () => {
  assert.throws(() => execFileSync("node", ["scripts/gen-update-feed.mjs"], { stdio: "pipe" }));
  assert.throws(() => execFileSync("node", ["scripts/gen-update-feed.mjs", "not-a-version"], { stdio: "pipe" }));
});

test("cli writes the feed file", () => {
  execFileSync("node", ["scripts/gen-update-feed.mjs", "2.0.1", "/tmp/updatePlugins-test.xml"]);
  assert.match(readFileSync("/tmp/updatePlugins-test.xml", "utf8"), /stewart-2\.0\.1\.zip/);
});
