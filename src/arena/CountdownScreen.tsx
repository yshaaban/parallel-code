import { createSignal, onMount, onCleanup, createEffect } from 'solid-js';
import { setPhase } from './store';

export function CountdownScreen() {
  const [count, setCount] = createSignal(3);
  let textRef: HTMLDivElement | undefined;

  onMount(() => {
    let current = 3;
    const interval = setInterval(() => {
      current--;
      if (current >= 0) {
        setCount(current);
      } else {
        clearInterval(interval);
        setPhase('battle');
      }
    }, 800);
    onCleanup(() => clearInterval(interval));
  });

  // Re-trigger the pulse animation each time count changes
  createEffect(() => {
    count(); // track the signal
    if (textRef) {
      textRef.style.animation = 'none';
      void textRef.offsetHeight; // force reflow
      textRef.style.animation = '';
    }
  });

  return (
    <div class="arena-countdown">
      <div
        ref={textRef}
        class={`arena-countdown-text${count() === 0 ? ' arena-countdown-go' : ''}`}
      >
        {count() > 0 ? count() : 'GO!'}
      </div>
    </div>
  );
}
