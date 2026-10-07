import { z } from "zod";

export const Tier = z.enum(["T0", "T1", "T2", "T3"]);
export type Tier = z.infer<typeof Tier>;

export const Trust = z.enum(["owner", "guest"]);
export type Trust = z.infer<typeof Trust>;
