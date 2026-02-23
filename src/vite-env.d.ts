/// <reference types="vite/client" />

// Chromium 133+ customizable <select> elements
declare module 'solid-js' {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace JSX {
    interface IntrinsicElements {
      selectedcontent: HTMLAttributes<HTMLElement>;
    }
  }
}

export {};
