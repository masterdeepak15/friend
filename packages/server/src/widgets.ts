import { StageObject } from "@friend/protocol";
import type { Db } from "./db";
import type { WidgetStore } from "./stage";

/** The pinned widgets, kept in the database so they are still there after a refresh, a login or a restart. */
export function dbWidgetStore(db: Db): WidgetStore {
  return {
    load() {
      const rows = db.prepare("select object_json j from widgets order by position").all() as { j: string }[];
      const out: StageObject[] = [];
      for (const r of rows) {
        try {
          const parsed = StageObject.safeParse(JSON.parse(r.j));
          if (parsed.success) out.push(parsed.data); // a damaged row is skipped, not fatal
        } catch {
          /* skipped */
        }
      }
      return out;
    },
    save(widgets) {
      const put = db.prepare("insert into widgets (id, object_json, position) values (?, ?, ?)");
      db.transaction(() => {
        db.prepare("delete from widgets").run();
        widgets.forEach((w, i) => put.run(w.id, JSON.stringify(w), i));
      })();
    },
  };
}
