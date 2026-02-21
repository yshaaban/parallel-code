import { onMount, onCleanup } from 'solid-js';
import { getFontScale, adjustFontScale } from '../store/store';
import type { JSX } from 'solid-js';
import { createCtrlWheelZoomHandler } from '../lib/wheelZoom';

interface ScalablePanelProps {
  panelId: string;
  children: JSX.Element;
  style?: JSX.CSSProperties;
}

export function ScalablePanel(props: ScalablePanelProps) {
  let ref!: HTMLDivElement;
  onMount(() => {
    const handleWheel = createCtrlWheelZoomHandler(
      (delta) => adjustFontScale(props.panelId, delta),
      { stopPropagation: true },
    );

    ref.addEventListener('wheel', handleWheel, { passive: false });
    onCleanup(() => {
      ref.removeEventListener('wheel', handleWheel);
    });
  });

  return (
    <div
      ref={ref}
      style={{
        '--font-scale': String(getFontScale(props.panelId)),
        width: '100%',
        height: '100%',
        ...props.style,
      }}
    >
      {props.children}
    </div>
  );
}
