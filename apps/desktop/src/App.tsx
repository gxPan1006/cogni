import { useAuth } from "./useAuth.js";
import { Login } from "./Login.js";
import { Shell } from "./Shell.js"; // created in Task 21

export default function App() {
  const { token, login, logout } = useAuth();
  if (!token) return <Login onLogin={login} />;
  return <Shell token={token} onLogout={logout} />;
}
