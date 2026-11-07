import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PendingApproval } from "@friend/protocol";
import { ApprovalWidget } from "./ApprovalWidget";

afterEach(cleanup);
const base: PendingApproval = { id: "a1", tool: "shell.run", summary: "Run shell command: ls", tier: "T2", needsPin: false };

describe("the orbital approval widget for a command that follows repository text", () => {
  it("offers Always allow for an ordinary command and not for a marked one", () => {
    const { rerender } = render(<ApprovalWidget approval={base} send={() => {}} />);
    expect(screen.getByRole("button", { name: /always allow/i })).toBeTruthy();
    rerender(<ApprovalWidget approval={{ ...base, origin: "github.com/o/r" }} send={() => {}} />);
    expect(screen.queryByRole("button", { name: /always allow/i })).toBeNull();
  });
});
