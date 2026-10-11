import { describe, expect, it } from "vitest";
import { musicReturnNotice } from "./returnNotice";

describe("coming back from Spotify", () => {
  it("says it worked", () => expect(musicReturnNotice("?music=connected")).toMatchObject({ level: "info", text: expect.stringMatching(/connected/i) }));
  it("says it did not, and where to try again", () => expect(musicReturnNotice("?music=failed")).toMatchObject({ level: "warn", text: expect.stringMatching(/Plugins, Spotify/) }));
  it("says nothing for any other address or value", () => {
    for (const s of ["", "?x=1", "?music=hacked", "?music=connected%20now"]) expect(musicReturnNotice(s)).toBeNull();
  });
});
