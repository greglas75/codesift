// Negative: useState(props.X) used as one-time seed, no syncing useEffect
import { useState } from "react";

export function SeedOnly(props: { initial: string }) {
  const [value, setValue] = useState(props.initial);
  return <input value={value} onChange={(e) => setValue(e.target.value)} />;
}
