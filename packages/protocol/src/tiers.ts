import { z } from "zod";

export const Tier = z.enum(["T0", "T1", "T2", "T3"]);
export type Tier = z.infer<typeof Tier>;

/** owner: the owner. member: a recognized person of the household (wife, son...): talks and sees pictures, nothing on the PC. guest: anyone else. */
export const Trust = z.enum(["owner", "guest", "member"]);
export type Trust = z.infer<typeof Trust>;
