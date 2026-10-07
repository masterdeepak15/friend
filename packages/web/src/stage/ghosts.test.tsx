import type { StageObject } from "@friend/protocol";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeGhosts, useGhosts } from "./ghosts";

const o = (id: string, text = id): StageObject => ({ id, type: "card", props: { text }, placement: "auto" });

describe("mergeGhosts", () => {
  it("marks removed objects as leaving and keeps their position", () => {
    const prev = [{ object: o("a"), leaving: false }, { object: o("b"), leaving: false }, { object: o("c"), leaving: false }];
    const next = mergeGhosts(prev, [o("a"), o("c")]);
    expect(next.map((e) => [e.object.id, e.leaving])).toEqual([["a", false], ["b", true], ["c", false]]);
  });
  it("appends new objects and takes updated props from the current list", () => {
    const next = mergeGhosts([{ object: o("a", "old"), leaving: false }], [o("a", "new"), o("z")]);
    expect(next.map((e) => e.object.id)).toEqual(["a", "z"]);
    expect(next[0]!.object.props).toEqual({ text: "new" });
  });
  it("brings a leaving object back when the same id is shown again, without duplicating it", () => {
    const next = mergeGhosts([{ object: o("a"), leaving: true }], [o("a", "again")]);
    expect(next).toHaveLength(1);
    expect(next[0]).toMatchObject({ leaving: false });
  });
});

describe("useGhosts", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("keeps a removed object as leaving for the exit time, then drops it", () => {
    const { result, rerender } = renderHook(({ objs }) => useGhosts(objs, 350), { initialProps: { objs: [o("a"), o("b")] } });
    rerender({ objs: [o("a")] });
    expect(result.current.map((e) => [e.object.id, e.leaving])).toEqual([["a", false], ["b", true]]);
    act(() => void vi.advanceTimersByTime(349));
    expect(result.current).toHaveLength(2);
    act(() => void vi.advanceTimersByTime(2));
    expect(result.current.map((e) => e.object.id)).toEqual(["a"]);
  });

  it("cancels the exit when the same id returns, leaving no stuck ghost or duplicate", () => {
    const { result, rerender } = renderHook(({ objs }) => useGhosts(objs, 350), { initialProps: { objs: [o("a")] } });
    rerender({ objs: [] });
    act(() => void vi.advanceTimersByTime(100));
    rerender({ objs: [o("a", "back")] });
    act(() => void vi.advanceTimersByTime(1000));
    expect(result.current).toHaveLength(1);
    expect(result.current[0]).toMatchObject({ leaving: false });
  });

  it("handles rapid show/hide cycles of one id", () => {
    const { result, rerender } = renderHook(({ objs }) => useGhosts(objs, 350), { initialProps: { objs: [] as StageObject[] } });
    for (let i = 0; i < 5; i++) {
      rerender({ objs: [o("x")] });
      rerender({ objs: [] });
    }
    act(() => void vi.advanceTimersByTime(400));
    expect(result.current).toEqual([]);
    expect(new Set(result.current.map((e) => e.object.id)).size).toBe(result.current.length);
  });

  it("times each leaving object independently", () => {
    const { result, rerender } = renderHook(({ objs }) => useGhosts(objs, 350), { initialProps: { objs: [o("a"), o("b")] } });
    rerender({ objs: [o("b")] });
    act(() => void vi.advanceTimersByTime(200));
    rerender({ objs: [] });
    act(() => void vi.advanceTimersByTime(160));
    expect(result.current.map((e) => e.object.id)).toEqual(["b"]);
    act(() => void vi.advanceTimersByTime(200));
    expect(result.current).toEqual([]);
  });

  it("removes immediately when the exit time is zero (reduced motion)", () => {
    const { result, rerender } = renderHook(({ objs }) => useGhosts(objs, 0), { initialProps: { objs: [o("a")] } });
    rerender({ objs: [] });
    expect(result.current).toEqual([]);
  });
});
