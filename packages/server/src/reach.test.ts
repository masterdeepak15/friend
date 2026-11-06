import { describe, expect, it, vi } from "vitest";
import { deliverToOwner, phoneText, sendToPhone, type OwnerChannel } from "./reach";

const make = (over: { screenOpen?: boolean; channels?: OwnerChannel[]; sendOk?: Partial<Record<OwnerChannel, boolean | "throw">> } = {}) => {
  const sent: { channel: OwnerChannel; text: string }[] = [];
  const shown: { title: string; text: string }[] = [];
  const audit = vi.fn();
  const deps = {
    screenOpen: over.screenOpen ?? false,
    channels: over.channels ?? (["telegram", "whatsapp", "sms"] as OwnerChannel[]),
    send: async (channel: OwnerChannel, text: string) => {
      sent.push({ channel, text });
      const v = over.sendOk?.[channel] ?? true;
      if (v === "throw") throw new Error("down");
      return { ok: v };
    },
    show: (title: string, text: string) => void shown.push({ title, text }),
    audit,
  };
  return { deps, sent, shown, audit };
};

describe("telling the owner something, whatever it is about", () => {
  it("shows it on the screen when one is open, and sends nothing to the phone", async () => {
    const m = make({ screenOpen: true });
    expect(await deliverToOwner("Ticket #1 is done.", m.deps, "Office update")).toBe("screen");
    expect(m.shown).toEqual([{ title: "Office update", text: "Ticket #1 is done." }]);
    expect(m.sent).toEqual([]);
  });

  it("with no screen open, sends it to Telegram first, as one message with its title", async () => {
    const m = make();
    expect(await deliverToOwner("Your report is ready.", m.deps, "Report")).toBe("telegram");
    expect(m.sent).toEqual([{ channel: "telegram", text: "Report\n\nYour report is ready." }]);
    expect(m.shown).toEqual([]);
    expect(m.audit).toHaveBeenCalledWith("owner.reached", { via: "telegram" });
  });

  it("tries the next way when one fails or throws: Telegram, then WhatsApp, then SMS", async () => {
    const m = make({ sendOk: { telegram: "throw", whatsapp: false } });
    expect(await deliverToOwner("Done.", m.deps)).toBe("sms");
    expect(m.sent.map((s) => s.channel)).toEqual(["telegram", "whatsapp", "sms"]);
  });

  it("when nothing reaches the owner, leaves it on the screen for when they come back, and says so in the log", async () => {
    const none = make({ channels: [] });
    expect(await deliverToOwner("Done.", none.deps)).toBe("screen-later");
    expect(none.shown).toEqual([{ title: "Friend", text: "Done." }]);
    expect(none.audit).toHaveBeenCalledWith("owner.unreached", { channels: 0 });
    const failing = make({ sendOk: { telegram: false, whatsapp: false, sms: false } });
    expect(await deliverToOwner("Done.", failing.deps)).toBe("screen-later");
  });

  it("sends nothing for empty words, and keeps a phone message short", async () => {
    const m = make();
    expect(await deliverToOwner("   ", m.deps)).toBeNull();
    expect(m.sent).toEqual([]);
    expect(phoneText("T", "x".repeat(5000)).length).toBe(1500);
  });

  it("sendToPhone alone gives the way it used, or null", async () => {
    expect(await sendToPhone(make({ channels: ["whatsapp"] }).deps, "hi")).toBe("whatsapp");
    expect(await sendToPhone(make({ channels: [] }).deps, "hi")).toBeNull();
  });
});
