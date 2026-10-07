import { useEffect } from "react";
import type { Alert, LocalAction } from "../store";

function Toast({ alert, dispatch }: { alert: Alert; dispatch: (a: LocalAction) => void }) {
  useEffect(() => {
    const t = setTimeout(() => dispatch({ type: "alert.dismiss", id: alert.id }), 5000);
    return () => clearTimeout(t);
  }, [alert.id, dispatch]);
  return (
    <div className={`toast toast-${alert.level}`} role="status" style={{ pointerEvents: "auto" }}>
      {alert.text}
    </div>
  );
}

export function AlertToast({ alerts, dispatch }: { alerts: Alert[]; dispatch: (a: LocalAction) => void }) {
  if (alerts.length === 0) return null;
  return (
    <div className="toasts">
      {alerts.map((a) => (
        <Toast key={a.id} alert={a} dispatch={dispatch} />
      ))}
    </div>
  );
}
