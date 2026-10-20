import { HexCells } from "../kit";

/** The ticket cells; with no Office yet there are none, and it says so. */
export function TicketsWidget() {
  return (
    <div className="ob-tickets">
      <HexCells cells={[]} placeholder />
      <p className="ob-li ob-sub">No workers yet</p>
    </div>
  );
}