// Negative: <Ctx.Provider value={memoizedValue}> via useMemo
import { createContext, useMemo } from "react";

const ThemeContext = createContext<{ mode: string } | null>(null);

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const memoizedValue = useMemo(() => ({ mode: "dark" }), []);
  return (
    <ThemeContext.Provider value={memoizedValue}>
      {children}
    </ThemeContext.Provider>
  );
}
