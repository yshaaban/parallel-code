import { createSignal, createEffect, onMount, onCleanup, For, type JSX } from "solid-js";

export interface PanelChild {
  id: string;
  initialSize?: number;
  fixed?: boolean;
  minSize?: number;
  maxSize?: number;
  content: () => JSX.Element;
}

interface ResizablePanelProps {
  direction: "horizontal" | "vertical";
  children: PanelChild[];
  class?: string;
  style?: JSX.CSSProperties;
}

export function ResizablePanel(props: ResizablePanelProps) {
  let containerRef!: HTMLDivElement;
  const [sizes, setSizes] = createSignal<number[]>([]);
  const [dragging, setDragging] = createSignal<number | null>(null);

  const isHorizontal = () => props.direction === "horizontal";

  function initSizes() {
    if (!containerRef) return;
    const totalSpace = isHorizontal()
      ? containerRef.clientWidth
      : containerRef.clientHeight;

    const children = props.children;
    const fixedTotal = children.reduce(
      (sum, c) => sum + (c.fixed ? (c.initialSize ?? 0) : 0),
      0
    );
    const handleSpace = Math.max(0, children.length - 1) * 4;
    const resizableSpace = totalSpace - fixedTotal - handleSpace;
    const resizableCount = children.filter((c) => !c.fixed).length;
    const defaultSize = resizableCount > 0 ? resizableSpace / resizableCount : 0;

    setSizes(
      children.map((c) => {
        if (c.fixed) return c.initialSize ?? 0;
        if (c.initialSize && c.initialSize < resizableSpace) return c.initialSize;
        return defaultSize;
      })
    );
  }

  onMount(() => {
    initSizes();

    const ro = new ResizeObserver(() => {
      const current = sizes();
      if (current.length === 0) {
        initSizes();
        return;
      }

      const totalSpace = isHorizontal()
        ? containerRef.clientWidth
        : containerRef.clientHeight;
      const handleSpace = Math.max(0, props.children.length - 1) * 4;
      const fixedTotal = props.children.reduce(
        (sum, c, i) => sum + (c.fixed ? current[i] : 0),
        0
      );
      const oldResizable = current.reduce(
        (sum, s, i) => sum + (props.children[i]?.fixed ? 0 : s),
        0
      );
      const newResizable = totalSpace - fixedTotal - handleSpace;

      if (oldResizable <= 0 || newResizable <= 0) return;

      const ratio = newResizable / oldResizable;
      setSizes(
        current.map((s, i) => (props.children[i]?.fixed ? s : s * ratio))
      );
    });
    ro.observe(containerRef);
    onCleanup(() => ro.disconnect());
  });

  // Re-init when children change
  createEffect(() => {
    void props.children.length;
    initSizes();
  });

  function handleMouseDown(handleIndex: number, e: MouseEvent) {
    e.preventDefault();
    setDragging(handleIndex);

    const startPos = isHorizontal() ? e.clientX : e.clientY;
    const startSizes = [...sizes()];

    function onMove(ev: MouseEvent) {
      const delta = (isHorizontal() ? ev.clientX : ev.clientY) - startPos;
      const leftIdx = handleIndex;
      const rightIdx = handleIndex + 1;
      const leftChild = props.children[leftIdx];
      const rightChild = props.children[rightIdx];

      if (leftChild?.fixed || rightChild?.fixed) return;

      let newLeft = startSizes[leftIdx] + delta;
      let newRight = startSizes[rightIdx] - delta;

      // Enforce min/max
      const leftMin = leftChild?.minSize ?? 30;
      const leftMax = leftChild?.maxSize ?? Infinity;
      const rightMin = rightChild?.minSize ?? 30;
      const rightMax = rightChild?.maxSize ?? Infinity;

      if (newLeft < leftMin) {
        newRight += newLeft - leftMin;
        newLeft = leftMin;
      }
      if (newRight < rightMin) {
        newLeft += newRight - rightMin;
        newRight = rightMin;
      }
      newLeft = Math.min(newLeft, leftMax);
      newRight = Math.min(newRight, rightMax);

      setSizes((prev) => {
        const next = [...prev];
        next[leftIdx] = newLeft;
        next[rightIdx] = newRight;
        return next;
      });
    }

    function onUp() {
      setDragging(null);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    }

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div
      ref={containerRef}
      class={props.class}
      style={{
        display: "flex",
        "flex-direction": isHorizontal() ? "row" : "column",
        width: "100%",
        height: "100%",
        overflow: "hidden",
        ...props.style,
      }}
    >
      <For each={props.children}>
        {(child, i) => {
          const size = () => sizes()[i()] ?? 0;
          const showHandle = () => {
            const idx = i();
            if (idx >= props.children.length - 1) return false;
            // Don't show handle between two fixed children
            if (child.fixed && props.children[idx + 1]?.fixed) return false;
            return true;
          };

          return (
            <>
              <div
                style={{
                  [isHorizontal() ? "width" : "height"]: `${size()}px`,
                  [isHorizontal() ? "min-width" : "min-height"]: `${child.minSize ?? 0}px`,
                  "flex-shrink": "0",
                  overflow: "hidden",
                }}
              >
                {child.content()}
              </div>
              {showHandle() && (
                <div
                  class={`resize-handle resize-handle-${isHorizontal() ? "h" : "v"} ${dragging() === i() ? "dragging" : ""}`}
                  onMouseDown={(e) => handleMouseDown(i(), e)}
                />
              )}
            </>
          );
        }}
      </For>
    </div>
  );
}
