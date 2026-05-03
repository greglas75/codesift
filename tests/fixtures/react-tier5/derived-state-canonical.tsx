// Canonical positive: useState(props.X) + useEffect that syncs setX(props.X)
import { useState, useEffect } from "react";

export function NameField(props: { name: string }) {
  const [name, setName] = useState(props.name);
  useEffect(() => {
    setName(props.name);
  }, [props.name]);
  return <input value={name} onChange={(e) => setName(e.target.value)} />;
}
