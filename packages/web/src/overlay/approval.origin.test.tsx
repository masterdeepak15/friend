import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { PendingApproval } from "@friend/protocol";
import { ApprovalCard } from "./ApprovalCard";

afterEach(cleanup);

const base: PendingApproval = { id: "a1", tool: "shell.run", summary: "Run shell command: npm install", tier: "T2", needsPin: false };

describe("the approval card for a command that follows text from the internet", () => {
  it("says where the text came from and lists each warning, above the command's buttons", () => {
    render(<ApprovalCard approval={{ ...base, origin: "github.com/o/r", warnings: ["It deletes folders and everything in them.", "It runs with administrator rights."] }} send={() => {}} />);
    const note = screen.getByTestId("approval-origin");
    expect(note.textContent).toContain("follows text from github.com/o/r");
    expect(note.textContent).toContain("It deletes folders and everything in them.");
    expect(note.textContent).toContain("It runs with administrator rights.");
  });

  it("shows nothing extra for an ordinary command, and offers no \"Always allow\" for a marked one", () => {
    const { rerender } = render(<ApprovalCard approval={base} send={() => {}} />);
    expect(screen.queryByTestId("approval-origin")).toBeNull();
    expect(screen.getByRole("button", { name: /always allow/i })).toBeTruthy();
    rerender(<ApprovalCard approval={{ ...base, origin: "github.com/o/r" }} send={() => {}} />);
    expect(screen.queryByRole("button", { name: /always allow/i })).toBeNull();
  });
});
