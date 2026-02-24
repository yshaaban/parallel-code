/// <reference types="vite/client" />

// Chromium 133+ customizable <select> elements (appearance: base-select)
// Safe in Electron — update type if a dedicated interface becomes available in the spec
declare module 'solid-js' {
  namespace JSX {
    interface IntrinsicElements {
      selectedcontent: HTMLAttributes<HTMLElement>;
    }
  }
}

export {};
