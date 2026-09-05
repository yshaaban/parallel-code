import { startElectronApplication } from './application.js';

// The shipped entrypoint is intentionally default-dark. A trusted promoter uses the side-effect-free
// application composition directly and supplies factory-issued, proof-bound entitlements.
startElectronApplication();
