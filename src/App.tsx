import "@xterm/xterm/css/xterm.css";
import { TerminalView } from "./components/TerminalView";

function App() {
  return (
    <main style={{ width: "100vw", height: "100vh", background: "#1e1e2e" }}>
      <TerminalView
        agentId="test-terminal"
        command="/bin/bash"
        args={[]}
        cwd={"/home/" + (typeof window !== "undefined" ? "johannes" : "user")}
      />
    </main>
  );
}

export default App;
