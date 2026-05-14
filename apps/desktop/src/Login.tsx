export function Login({ onLogin }: { onLogin: () => void }) {
  return (
    <div style={{ display: "grid", placeItems: "center", height: "100vh" }}>
      <div style={{ textAlign: "center" }}>
        <h1>Cogni</h1>
        <p>有记忆、跨设备在场的 AI 助手</p>
        <button onClick={onLogin}>用 Google 登录</button>
      </div>
    </div>
  );
}
