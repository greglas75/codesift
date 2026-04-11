import { useState } from 'react';
export default function Counter({ count = 0 }: { count?: number }) {
  const [value, setValue] = useState(count);
  return <button onClick={() => setValue(v => v + 1)}>Count: {value}</button>;
}
