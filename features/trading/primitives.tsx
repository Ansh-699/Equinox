import { Check, LoaderCircle } from "lucide-react";

export function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

export function Step({ complete, active, label }: { complete: boolean; active: boolean; label: string }) {
  return (
    <div className={active ? "step active-step" : complete ? "step complete-step" : "step"}>
      <span>{complete ? <Check size={13} /> : active ? <LoaderCircle size={13} /> : ""}</span>
      <p>{label}</p>
    </div>
  );
}
