// Canonical positive: <Ctx.Provider value={{...}}> inline literal
import { createContext } from "react";

interface AuthCtx {
  user: string | null;
  login: () => void;
  logout: () => void;
}

const AuthContext = createContext<AuthCtx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const user = "alice";
  const login = () => {};
  const logout = () => {};
  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}
