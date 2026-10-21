import { z } from "zod";

/** The shapes of the Office: workers Friend hires, the tickets it gives them, and what screens are told. */

/** An id the owner can type: lowercase letters, digits and dashes, up to 24 characters. */
export const SLUG = /^[a-z0-9][a-z0-9-]{0,23}$/;
const slug = z.string().regex(SLUG, "Lowercase letters, digits and dashes, up to 24 characters");

export const WORKER_STATUSES = ["starting", "running", "waiting", "idle", "paused", "stopped", "failed"] as const;
export type WorkerStatus = (typeof WORKER_STATUSES)[number];
export const TICKET_STATUSES = ["todo", "doing", "review", "done", "blocked"] as const;
export type TicketStatus = (typeof TICKET_STATUSES)[number];

/** A kind of worker. Everything about it is the owner's: nothing in code names a role. */
export const OfficeRole = z.object({
  id: slug,
  title: z.string().min(1).max(40),
  instructions: z.string().max(4000),
  /** Empty: the model chosen under Model (Claude Code). */
  model: z.string().max(100),
  /** Claude Code never gets to skip its questions: "default" asks, "acceptEdits" lets edits in the folder through (still gated by Friend). */
  permission: z.enum(["default", "acceptEdits"]),
});
export type OfficeRole = z.infer<typeof OfficeRole>;

export const OfficeProject = z.object({
  id: slug,
  name: z.string().min(1).max(60),
  folder: z.string().min(1).max(260),
  goal: z.string().max(500),
  extraFolders: z.array(z.string().min(1).max(260)).max(5),
});
export type OfficeProject = z.infer<typeof OfficeProject>;

/** What a worker may do without asking, and what it may never do. */
export const OfficePolicy = z.object({
  /** Tool names Friend lets through without asking, after the project fence. */
  allowTools: z.array(z.string().min(1).max(60)).max(40),
  /** Regular expressions matched against a shell command: a match is always refused. */
  denyCommands: z.array(z.string().min(1).max(200)).max(40),
});
export type OfficePolicy = z.infer<typeof OfficePolicy>;

export const OfficeWorkerView = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(40),
  /** The starter role this worker was made from, if any (free-form hires have none). */
  roleId: z.string().max(24),
  /** The job, in a few words: shown on the org chart. */
  title: z.string().max(60),
  /** What they are good at, one line. */
  capabilities: z.string().max(200),
  /** Who they report to: another worker's id, or null for Friend. */
  managerId: z.string().max(64).nullable(),
  projectId: z.string().max(24),
  status: z.enum(WORKER_STATUSES),
  ticketId: z.number().int().nullable(),
  detail: z.string().max(80),
  tokens: z.number().min(0),
  budget: z.number().min(0).nullable(),
  startedAt: z.number().nullable(),
});
export type OfficeWorkerView = z.infer<typeof OfficeWorkerView>;

export const OfficeTicketView = z.object({
  id: z.number().int(),
  projectId: z.string().max(24),
  title: z.string().max(200),
  status: z.enum(TICKET_STATUSES),
  workerId: z.string().max(64).nullable(),
});
export type OfficeTicketView = z.infer<typeof OfficeTicketView>;

const Window = z.object({ utilization: z.number().min(0).max(1), resetsAt: z.number() });
/** How full the owner's Claude subscription windows are, as the workers last reported them. */
export const OfficeQuota = z.object({ fiveHour: Window.nullable(), sevenDay: Window.nullable() });
export type OfficeQuota = z.infer<typeof OfficeQuota>;

export const OFFICE_FEED_KINDS = ["text", "tool", "result", "approval", "error"] as const;
export const MAX_FEED_CHARS = 200;