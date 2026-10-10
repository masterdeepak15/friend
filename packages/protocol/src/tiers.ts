import { z } from "zod";

export const Tier = z.enum(["T0", "T1", "T2", "T3"]);
export type Tier = z.infer<typeof Tier>;

/**
 * owner: the owner. member: a recognized person of the household (wife, son...): talks and sees pictures, nothing on the PC.
 * guest: anyone else. voice-device: the owner's account, but speaking through a speaker (Alexa) that anyone in the room can
 * talk to: reading tools only, and anything else needs the owner's yes on their phone.
 */
export const Trust = z.enum(["owner", "guest", "member", "voice-device"]);
export type Trust = z.infer<typeof Trust>;
