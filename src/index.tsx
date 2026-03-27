import { render } from 'solid-js/web';
import './lib/monaco-workers';
import { registerMonacoThemes } from './lib/monaco-theme';
import { installTerminalDiagnosticsCapture } from './app/terminal-diagnostics-capture';
import { installTerminalAnomalyMonitor } from './app/terminal-anomaly-monitor';
import { installUiFluidityDiagnostics } from './app/ui-fluidity-diagnostics';
import { installTerminalLatencyDiagnostics } from './lib/terminalLatency';
import App from './App';

registerMonacoThemes();
installTerminalDiagnosticsCapture();
installTerminalAnomalyMonitor();
installUiFluidityDiagnostics();
installTerminalLatencyDiagnostics();

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Missing root element');
}

render(() => <App />, rootElement);
