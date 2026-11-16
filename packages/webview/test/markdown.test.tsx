import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/preact";
import { renderMarkdown } from "../src/markdown.js";

afterEach(cleanup);

function renderMd(src: string) {
  return render(<div>{renderMarkdown(src)}</div>);
}

describe("markdown rendering", () => {
  it("renders a heading", () => {
    renderMd("## Heading");
    expect(screen.getByText("Heading").closest(".md-h2")).toBeTruthy();
  });

  it("renders a list and an ordered list", () => {
    renderMd("- a\n- b\n\n1. first\n2. second");
    expect(screen.getAllByRole("listitem").length).toBe(4);
    expect(screen.getByText("first")).toBeTruthy();
  });

  it("renders a fenced code block verbatim (no inline parsing inside)", () => {
    renderMd("```js\nlet a = 1; // **not bold**\n```");
    const code = screen.getByText(/let a = 1;/);
    expect(code.tagName.toLowerCase()).toBe("code");
    expect(code.closest("pre")).toBeTruthy();
    expect(screen.queryByText("not bold")).toBeNull();
  });

  it("renders a pipe table with header and rows", () => {
    renderMd("| Agent | Tools |\n| --- | --- |\n| claude | native |");
    const table = screen.getByRole("table");
    expect(table.querySelectorAll("thead th").length).toBe(2);
    expect(table.querySelectorAll("tbody td").length).toBe(2);
    expect(screen.getByText("Agent")).toBeTruthy();
    expect(screen.getByText("claude")).toBeTruthy();
  });

  it("renders bold, inline code and a link", () => {
    renderMd("This is **bold** with `code` and a [link](https://x.test) here.");
    expect(screen.getByText("bold").tagName.toLowerCase()).toBe("strong");
    const code = screen.getByText("code");
    expect(code.tagName.toLowerCase()).toBe("code");
    expect(screen.getByText("link").getAttribute("href")).toBe("https://x.test");
  });

  it("escapes raw HTML in the source (no injection)", () => {
    renderMd("safe <script>alert(1)</script> text");
    expect(screen.getByText("safe <script>alert(1)</script> text")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("joins consecutive lines into one paragraph with a line break", () => {
    renderMd("line one\nline two\n\nnext paragraph");
    const br = document.querySelector("p br");
    expect(br).toBeTruthy();
    expect(screen.getByText("next paragraph")).toBeTruthy();
  });

  it("renders plain text as a paragraph with no special nodes", () => {
    renderMd("Just a plain reply.");
    expect(screen.getByText("Just a plain reply.").closest("p")).toBeTruthy();
    expect(document.querySelector(".md-table")).toBeNull();
  });

  it("drops script/data hrefs from links", () => {
    renderMd("[x](javascript:alert(1)) and [y](https://ok.test)");
    expect(screen.getByText("x").closest("a")?.getAttribute("href")).toBeNull();
    expect(screen.getByText("y").closest("a")?.getAttribute("href")).toBe("https://ok.test");
  });

  it("renders an empty string as nothing", () => {
    const { container } = renderMd("");
    expect(container.textContent).toBe("");
  });
});
