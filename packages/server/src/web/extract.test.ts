import { describe, expect, it } from "vitest";
import { extractText } from "./extract";

describe("reading a page", () => {
  it("takes the title", () => {
    expect(extractText("<html><head><title> Nifty 50 Live &amp; Today </title></head><body><p>x</p></body></html>").title).toBe("Nifty 50 Live & Today");
    expect(extractText("<p>no title here</p>").title).toBe("");
  });

  it("drops scripts, styles, menus, footers, forms, comments and hidden things", () => {
    const html = `<html><head><style>.a{color:red}</style><script>var secret = "evil";</script></head><body>
      <!-- hidden note -->
      <nav>Home | About | Login</nav>
      <header>Site header</header>
      <p>The real story.</p>
      <form><input value="x"><button>Subscribe now</button></form>
      <div hidden>invisible</div><div style="display:none">also invisible</div><noscript>enable js</noscript>
      <svg><text>logo</text></svg><iframe src="x">frame</iframe>
      <footer>Copyright</footer></body></html>`;
    const { text } = extractText(html);
    expect(text).toContain("The real story.");
    for (const gone of ["evil", "color:red", "hidden note", "Home | About", "Site header", "Subscribe", "invisible", "enable js", "logo", "frame", "Copyright"]) expect(text, gone).not.toContain(gone);
  });

  it("decodes the usual character references", () => {
    expect(extractText("<p>Tom &amp; Jerry &lt;3 &quot;hi&quot; &#8377;100 &#x20B9;5 &nbsp;ok &apos;</p>").text).toBe(`Tom & Jerry <3 "hi" ₹100 ₹5 ok '`);
    expect(extractText("<p>&notanentity; &#99999999999;</p>").text).toContain("&notanentity;");
  });

  it("keeps paragraphs and list items on their own lines and collapses spaces", () => {
    const { text } = extractText("<h1>Title</h1><p>One   two\n three</p><ul><li>a</li><li>b</li></ul><br>last<div>end</div>");
    expect(text).toBe("Title\nOne two three\na\nb\nlast\nend");
  });

  it("prefers the main article when the page has one", () => {
    const { text } = extractText("<body><div>Trending: ten things</div><article><p>The article.</p></article><div>Related links</div></body>");
    expect(text).toBe("The article.");
    expect(extractText("<body><main><p>Main part.</p></main><aside>side</aside></body>").text).toBe("Main part.");
  });

  it("reads a table row as a line", () => {
    expect(extractText("<table><tr><td>Nifty</td><td>22,363.35</td></tr><tr><td>Sensex</td><td>71,925</td></tr></table>").text).toBe("Nifty | 22,363.35\nSensex | 71,925");
  });

  it("cuts a long page at the limit and says how much was left out", () => {
    const html = "<p>" + "word ".repeat(5000) + "</p>";
    const r = extractText(html, 1000);
    expect(r.text.length).toBe(1000);
    expect(r.cut).toBeGreaterThan(20_000);
    expect(extractText("<p>short</p>", 1000).cut).toBe(0);
  });

  it("passes plain text through unchanged", () => {
    expect(extractText("Just some plain text.\nSecond line.").text).toBe("Just some plain text.\nSecond line.");
  });

  it("does not choke on broken or hostile markup", () => {
    expect(() => extractText("<p>unclosed <b>bold <script>alert(1)")).not.toThrow();
    expect(extractText("<p>unclosed <b>bold <script>alert(1)").text).toBe("unclosed bold");
    expect(extractText("<<<>>>&&&<p").text).toBeTypeOf("string");
    expect(extractText("").text).toBe("");
    const nasty = "<div>".repeat(20_000) + "x";
    expect(() => extractText(nasty)).not.toThrow();
  });

  it("is quick on a big page", () => {
    const big = ("<div><p>some text &amp; more</p><a href='/x'>link</a></div>").repeat(40_000);
    const t = Date.now();
    extractText(big);
    expect(Date.now() - t).toBeLessThan(2000);
  });
});
