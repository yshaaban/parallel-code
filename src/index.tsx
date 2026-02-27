import { render } from 'solid-js/web';
import './lib/monaco-workers';
import { registerMonacoThemes } from './lib/monaco-theme';
import App from './App';

registerMonacoThemes();

render(() => <App />, document.getElementById('root') as HTMLElement);
