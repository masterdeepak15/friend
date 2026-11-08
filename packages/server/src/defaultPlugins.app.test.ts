import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";

const catalog = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins");
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const boot = async (dataDir: string, extra: object = {}) => {
  app = await createApp({ dataDir, provider: new FakeProvider([]), config: { port: 0, roots: [] }, pluginCatalogDir: catalog, ...extra });
  return app;
};
const ids = (a: Awaited<ReturnType<typeof createApp>>) => (a.db.prepare("select id from plugins order by id").all() as { id: string }[]).map((r) => r.id);

describe("the plugins that come with Friend", () => {
  it("installs the screen-design skill on the first start, once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-defaults-app-"));
    expect(ids(await boot(dir, { defaultPlugins: ["screen-design"] }))).toEqual(["screen-design"]);
    await app!.stop();
    const again = await boot(dir, { defaultPlugins: ["screen-design"] });
    again.db.prepare("delete from plugins where id = 'screen-design'").run(); // the owner removed it
    await app!.stop();
    expect(ids(await boot(dir, { defaultPlugins: ["screen-design"] }))).toEqual([]); // and it stays removed
  });
  it("installs nothing when a catalog folder is given and no defaults are asked for (tests, custom setups)", async () => {
    expect(ids(await boot(mkdtempSync(join(tmpdir(), "friend-defaults-app-"))))).toEqual([]);
  });
});
