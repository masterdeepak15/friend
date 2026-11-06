import { AsyncLocalStorage } from "node:async_hooks";
import { randomBytes } from "node:crypto";
import type { ActorKind } from "./audit";

/** What an entry is part of: the request it belongs to, the request that caused that one, and who is acting inside it. */
export interface ReqCtx {
  requestId: string;
  parentId: string | null;
  actorKind?: ActorKind;
  actorId?: string;
}

const store = new AsyncLocalStorage<ReqCtx>();

export const newRequestId = (prefix: string): string => `${prefix}-${randomBytes(4).toString("hex")}`;

/**
 * Runs `fn` as a request of its own. Everything `fn` starts, awaited or not, carries its id. Started inside another request it is that
 * one's child (`parentId`), unless a parent is given. A jobs queue or timer that runs later must call this inside the job itself:
 * the context is the one the code was started in, not the one that queued it.
 */
export function runWithRequest<T>(ctx: Partial<ReqCtx> & { prefix: string }, fn: () => T): T {
  const outer = store.getStore();
  const next: ReqCtx = {
    requestId: ctx.requestId ?? newRequestId(ctx.prefix),
    parentId: ctx.parentId !== undefined ? ctx.parentId : (outer?.requestId ?? null),
  };
  const actorKind = ctx.actorKind ?? outer?.actorKind;
  const actorId = ctx.actorId ?? outer?.actorId;
  if (actorKind) next.actorKind = actorKind;
  if (actorId) next.actorId = actorId;
  return store.run(next, fn);
}

export const currentRequest = (): ReqCtx | undefined => store.getStore();

/** Starts a request only when none is running yet (for code reached both from a request and on its own). */
export function ensureRequest<T>(prefix: string, fn: () => T): T {
  return store.getStore() ? fn() : runWithRequest({ prefix }, fn);
}
