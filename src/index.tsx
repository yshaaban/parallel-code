import { render } from 'solid-js/web';
import { installTerminalAnomalyMonitor } from './app/terminal-anomaly-monitor';
import { installTerminalDiagnosticsLoader } from './app/terminal-diagnostics-loader';
import { emitStartupBreadcrumb } from './app/startup-breadcrumbs';
import { installTerminalLatencyDiagnostics } from './lib/terminalLatency';
import App from './App';

emitStartupBreadcrumb('index:before-install-terminal-diagnostics');
installTerminalAnomalyMonitor();
installTerminalLatencyDiagnostics();
const terminalDiagnosticsReady = installTerminalDiagnosticsLoader();

function renderApplication(): void {
  emitStartupBreadcrumb('index:after-install-terminal-diagnostics');

  const rootElement = document.getElementById('root');
  if (!rootElement) {
    throw new Error('Missing root element');
  }

  emitStartupBreadcrumb('index:before-render');
  render(() => <App />, rootElement);
  emitStartupBreadcrumb('index:after-render');
}

if (terminalDiagnosticsReady) {
  void terminalDiagnosticsReady.then(renderApplication, renderApplication);
} else {
  renderApplication();
}
