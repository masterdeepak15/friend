import { HexCells, type TicketStatus } from "../kit";

const COUNTS: { status: TicketStatus; label: string }[] = [
  { status: "done", label: "DONE" },
  { status: "doing", label: "DOING" },
  { status: "review", label: "REVIEW" },
  { status: "todo", label: "TODO" },
];

/** Hexagon cells coloured by status, with the project in the title and a legend of counts. With no workers yet it is a dim honeycomb, zeros, and says so. */
export function TicketsWidget({ cells = [], project }: { cells?: { status: TicketStatus }[]; project?: string }) {
  const empty = cells.length === 0;
  return (
    <svg className="ob-wsvg" viewBox="0 0 270 160">
      <text className="ob-lab" x="0" y="8">TICKETS · {project ?? "no workers yet"}</text>
      <HexCells cells={cells} placeholder={empty} frame={{ x: 0, y: 20, w: 260, h: 80 }} />
      <text className="ob-dim" x="0" y="130">{COUNTS.map((c) => `■ ${c.label} ${cells.filter((x) => x.status === c.status).length}`).join("   ")}</text>
    </svg>
  );
}