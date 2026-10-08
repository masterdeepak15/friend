import { describe, expect, it } from "vitest";
import { ApprovalRespond, ClientMsg, Placement, ServerMsg, StageCommand, StageObject, describeCall } from "./index";

const obj = { id: "a", type: "card", props: { text: "hi" }, placement: "center" };

describe("stage schemas", () => {
  it("parses a valid show command", () => {
    expect(StageCommand.safeParse({ cmd: "show", object: obj }).success).toBe(true);
  });
  it("rejects a relative placement outside 0..1", () => {
    expect(Placement.safeParse({ x: 1.5, y: 0, w: 0.2, h: 0.2 }).success).toBe(false);
  });
  it("rejects an object type outside the catalog", () => {
    expect(StageObject.safeParse({ ...obj, type: "html" }).success).toBe(false);
  });
});

describe("voice messages", () => {
  const chunk = { type: "audio.chunk", id: "a1", seq: 0, last: false, mime: "audio/wav", data: "UklGRg==" };
  it("accepts voice.heard, audio.chunk and audio.stop from the server", () => {
    expect(ServerMsg.safeParse({ type: "voice.heard", text: "hello" }).success).toBe(true);
    expect(ServerMsg.safeParse(chunk).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "audio.stop" }).success).toBe(true);
  });
  it("rejects malformed audio chunks", () => {
    expect(ServerMsg.safeParse({ ...chunk, seq: -1 }).success).toBe(false);
    expect(ServerMsg.safeParse({ ...chunk, seq: 1.5 }).success).toBe(false);
    expect(ServerMsg.safeParse({ ...chunk, data: 5 }).success).toBe(false);
    expect(ServerMsg.safeParse({ ...chunk, last: "yes" }).success).toBe(false);
    expect(ServerMsg.safeParse({ type: "audio.chunk", id: "a1" }).success).toBe(false);
  });
  it("carries voice availability on status and keeps old status messages valid", () => {
    expect(ServerMsg.safeParse({ type: "status", busy: false, deviceOnline: true, voiceAvailable: true }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "status", busy: false, deviceOnline: true }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "status", busy: false, deviceOnline: true, voiceAvailable: "yes" }).success).toBe(false);
  });
  it("accepts voice.interrupt from the client", () => {
    expect(ClientMsg.safeParse({ type: "voice.interrupt" }).success).toBe(true);
  });
});

describe("speaker verification messages", () => {
  it("voice.heard can carry how much the voice was trusted", () => {
    for (const trust of ["owner", "guest", "unverified"]) {
      expect(ServerMsg.safeParse({ type: "voice.heard", text: "hi", trust }).success).toBe(true);
    }
    expect(ServerMsg.safeParse({ type: "voice.heard", text: "hi" }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "voice.heard", text: "hi", trust: "admin" }).success).toBe(false);
  });
  it("accepts a challenge and its end from the server", () => {
    expect(ServerMsg.safeParse({ type: "voice.challenge", id: "c1", text: "open the garage" }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "voice.challenge.end", id: "c1" }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "voice.challenge", id: "c1" }).success).toBe(false);
  });
  it("status carries whether a voice is enrolled", () => {
    expect(ServerMsg.safeParse({ type: "status", busy: false, deviceOnline: true, voiceEnrolled: true }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "status", busy: false, deviceOnline: true, voiceEnrolled: "yes" }).success).toBe(false);
  });
  it("carries camera requests to the browser and denials back", () => {
    expect(ServerMsg.safeParse({ type: "camera.request", id: "r1" }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "camera.cancel", id: "r1" }).success).toBe(true);
    expect(ServerMsg.safeParse({ type: "camera.request" }).success).toBe(false);
    for (const reason of ["off", "no-camera", "permission", "busy"]) {
      expect(ClientMsg.safeParse({ type: "camera.denied", id: "r1", reason }).success).toBe(true);
    }
    expect(ClientMsg.safeParse({ type: "camera.denied", id: "r1", reason: "because" }).success).toBe(false);
  });

  it("describes the camera tool honestly on the approval card", () => {
    const s = describeCall("camera.snap", {});
    expect(s).toMatch(/one picture/i);
    expect(s).toMatch(/AI model/);
  });

  it("accepts voice.confirm with a PIN and voice.cancel from the client", () => {
    expect(ClientMsg.safeParse({ type: "voice.confirm", id: "c1", pin: "123456" }).success).toBe(true);
    expect(ClientMsg.safeParse({ type: "voice.cancel", id: "c1" }).success).toBe(true);
    expect(ClientMsg.safeParse({ type: "voice.confirm", id: "c1" }).success).toBe(false);
    expect(ClientMsg.safeParse({ type: "voice.confirm", id: "c1", pin: "x".repeat(40) }).success).toBe(false);
  });
});

describe("client messages", () => {
  it("rejects an unknown approval decision", () => {
    expect(ApprovalRespond.safeParse({ type: "approval.respond", id: "1", decision: "maybe" }).success).toBe(false);
  });
  it("rejects an unknown message type", () => {
    expect(ClientMsg.safeParse({ type: "rm.rf" }).success).toBe(false);
  });
  it("accepts chat.send", () => {
    expect(ClientMsg.safeParse({ type: "chat.send", text: "hello" }).success).toBe(true);
  });
});
