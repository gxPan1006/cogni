import { useAuth } from "./useAuth.js";
import { Login } from "./Login.js";
import { Shell } from "./Shell.js";

export default function App() {
  const { token, loginWithGoogle, loginWithEmail, logout } = useAuth();
  if (!token) {
    return <Login onLoginWithGoogle={loginWithGoogle} onLoginWithEmail={loginWithEmail} />;
  }
  return <Shell token={token} onLogout={logout} />;
}
