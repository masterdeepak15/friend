import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PluginList, PluginsApi } from "./pluginsApi";
import { PluginsPanel } from "./PluginsPanel";

afterEach(cleanup);

const plugin = (id: string, source?: string) => ({ id, name: id, version: "1.0.0", description: "d", enabled: true, error: null, skills: [{ name: "s", description: "d" }], tools: [], ...(source ? { source } : {}) });

function show(installed: ReturnType<typeof plugin>[]) {
  const state = { installed, catalog: [], integrations: [] } as unknown as PluginList;
  const api: PluginsApi = { list: vi.fn(async () => state), install: vi.fn(), setEnabled: vi.fn(), remove: vi.fn(), reload: vi.fn() } as unknown as PluginsApi;
  render(<PluginsPanel api={api} onClose={() => {}} variant="holo" />);
}

describe("where an installed plugin came from", () => {
  it("says so for a plugin imported from GitHub, and only for that one", async () => {
    show([plugin("lemo-opuscar", "github.com/lemomo-ai/lemo-opuscar@abc1234"), plugin("mine")]);
    const items = await screen.findAllByRole("listitem");
    expect(items).toHaveLength(2);
    expect(items[0]!.textContent).toContain("from github.com/lemomo-ai/lemo-opuscar@abc1234");
    expect(items[1]!.textContent).not.toMatch(/from github/);
  });
});
