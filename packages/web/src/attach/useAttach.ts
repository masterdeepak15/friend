import { useCallback, useMemo, useRef, useState, type ClipboardEvent, type DragEvent } from "react";

/** A file that is uploaded and goes with the message: the id the server gave it, and its name. */
export interface AttachedFile {
  id: string;
  name: string;
}

export interface PendingFile {
  key: number;
  name: string;
  size: number;
  state: "uploading" | "ready" | "failed";
  id?: string;
  error?: string;
}

export type Uploader = (file: File) => Promise<AttachedFile>;

/** What is sent when files go without any words. */
export const FILES_ONLY_TEXT = "Please read the attached file.";

/** The most files one message carries (the same as the protocol allows). */
export const MAX_ATTACHED = 10;

/** Sends one file to Friend. The size limit is the owner's setting on the server, and its words come back as the error. */
export async function uploadFile(file: File): Promise<AttachedFile> {
  const res = await fetch(`/api/chat/upload?name=${encodeURIComponent(file.name)}`, { method: "POST", headers: { "content-type": "application/octet-stream" }, body: file });
  const body = (await res.json().catch(() => ({}))) as { id?: string; name?: string; error?: string };
  if (!res.ok || !body.id) throw new Error(body.error ?? `The upload failed (${res.status}).`);
  return { id: body.id, name: body.name ?? file.name };
}

/**
 * The files being attached to the message that is being written: picked with the button, dropped on the box or pasted into it. Each is
 * uploaded as soon as it is chosen; the message can be sent once none is still uploading.
 */
export function useAttach(upload: Uploader = uploadFile) {
  const [items, setItems] = useState<PendingFile[]>([]);
  const counter = useRef(0);
  const count = useRef(0);
  count.current = items.length;

  const add = useCallback(
    (files: File[]) => {
      for (const file of files.slice(0, Math.max(0, MAX_ATTACHED - count.current))) {
        const key = ++counter.current;
        count.current++;
        setItems((cur) => [...cur, { key, name: file.name, size: file.size, state: "uploading" }]);
        upload(file).then(
          (r) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, state: "ready", id: r.id, name: r.name } : i))),
          (e: Error) => setItems((cur) => cur.map((i) => (i.key === key ? { ...i, state: "failed", error: e.message } : i))),
        );
      }
    },
    [upload],
  );
  const remove = useCallback((key: number) => setItems((cur) => cur.filter((i) => i.key !== key)), []);
  const clear = useCallback(() => setItems([]), []);

  const ready: AttachedFile[] = useMemo(() => items.flatMap((i) => (i.state === "ready" && i.id ? [{ id: i.id, name: i.name }] : [])), [items]);
  const busy = items.some((i) => i.state === "uploading");

  const handlers = useMemo(
    () => ({
      onDragOver: (e: DragEvent) => {
        if (Array.from(e.dataTransfer?.types ?? []).includes("Files")) e.preventDefault();
      },
      onDrop: (e: DragEvent) => {
        const files = Array.from(e.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        e.preventDefault();
        add(files);
      },
      onPaste: (e: ClipboardEvent) => {
        const files = Array.from(e.clipboardData?.files ?? []);
        if (files.length === 0) return; // plain text pastes as usual
        e.preventDefault();
        add(files);
      },
    }),
    [add],
  );

  return { items, add, remove, clear, ready, busy, handlers };
}

export type Attach = ReturnType<typeof useAttach>;
