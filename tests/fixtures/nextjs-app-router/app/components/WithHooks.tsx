import { useState } from "react";

// No "use client" directive, but uses hooks — client_inferred case
export function WithHooks() {
  const [value, setValue] = useState("");
  return <input value={value} onChange={(e) => setValue(e.target.value)} />;
}
