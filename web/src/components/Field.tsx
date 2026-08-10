import { cloneElement, useId } from "react";
import { Label } from "./ui/label";

// The label was previously not associated with its input at all — no htmlFor, no id — so screen
// readers announced an unlabelled field and clicking the label did nothing. Generating the id
// here keeps every call site unchanged.
export function Field({ label, children }: { label: string; children: React.ReactElement<{ id?: string }> }) {
  const id = useId();

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      {cloneElement(children, { id })}
    </div>
  );
}
