import { Rings } from "../kit";

/** One ring per worker; with no Office yet there are none, and it says so. */
export function BudgetWidget() {
  return (
    <div className="ob-budget">
      <Rings rings={[]} />
      <p className="ob-li ob-sub">No workers yet</p>
    </div>
  );
}