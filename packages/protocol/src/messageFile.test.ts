import { describe, expect, it } from "vitest";
import { describeCall, TOOL_DEFS } from "./tools";

const tool = () => TOOL_DEFS.find((t) => t.name === "message.send_file")!;

describe("message.send_file", () => {
  it("takes a Telegram or WhatsApp channel, the owner, an absolute path and an optional caption", () => {
    expect(tool()).toMatchObject({ baseTier: "T2", target: "gateway" });
    const ok = tool().input.safeParse({ channel: "telegram", to: "me", path: "D:\Pictures\a.png", caption: "hi" });
    expect(ok.success).toBe(true);
    expect(tool().input.safeParse({ channel: "whatsapp", to: "me", path: "/home/a.png" }).success).toBe(true);
  });

  it("refuses SMS, other recipients, an empty path and a long caption", () => {
    expect(tool().input.safeParse({ channel: "sms", to: "me", path: "/a.png" }).success).toBe(false);
    expect(tool().input.safeParse({ channel: "telegram", to: "+919800000001", path: "/a.png" }).success).toBe(false);
    expect(tool().input.safeParse({ channel: "telegram", to: "me", path: "" }).success).toBe(false);
    expect(tool().input.safeParse({ channel: "telegram", to: "me", path: "/a.png", caption: "x".repeat(1001) }).success).toBe(false);
  });

  it("is described on the approval card with the file, the channel and the caption", () => {
    const text = describeCall("message.send_file", { channel: "telegram", to: "me", path: "D:\Pictures\a.png", caption: "Here you go" });
    expect(text).toContain("D:\Pictures\a.png");
    expect(text).toContain("Telegram");
    expect(text).toContain("Here you go");
  });
});
