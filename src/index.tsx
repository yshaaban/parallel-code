import { render } from 'solid-js/web';
import { installTerminalDiagnosticsCapture } from './app/terminal-diagnostics-capture';
import { installTerminalAnomalyMonitor } from './app/terminal-anomaly-monitor';
import { emitStartupBreadcrumb } from './app/startup-breadcrumbs';
import { installUiFluidityDiagnostics } from './app/ui-fluidity-diagnostics';
import { installTerminalLatencyDiagnostics } from './lib/terminalLatency';
import App from './App';

emitStartupBreadcrumb('index:before-install-terminal-diagnostics');
installTerminalDiagnosticsCapture();
installTerminalAnomalyMonitor();
installUiFluidityDiagnostics();
installTerminalLatencyDiagnostics();
emitStartupBreadcrumb('index:after-install-terminal-diagnostics');

const rootElement = document.getElementById('root');

if (!rootElement) {
  throw new Error('Missing root element');
}

emitStartupBreadcrumb('index:before-render');
render(() => <App />, rootElement);
emitStartupBreadcrumb('index:after-render');
