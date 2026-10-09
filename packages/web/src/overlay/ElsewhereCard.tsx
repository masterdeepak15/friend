/** Shown on a window that does not have Friend: it is open in another window, and this one can take it over. */
export function ElsewhereCard({ onUseHere }: { onUseHere: () => void }) {
  return (
    <div className="elsewhere" role="alertdialog" aria-labelledby="elsewhere-title" data-testid="elsewhere">
      <div className="elsewhere-card">
        <h2 id="elsewhere-title">Friend is open in another window</h2>
        <p>Friend works in one window at a time. Click &ldquo;Use here&rdquo; to use it in this window instead; the other one will stop.</p>
        <button type="button" className="elsewhere-btn" onClick={onUseHere} autoFocus>
          Use here
        </button>
      </div>
    </div>
  );
}
