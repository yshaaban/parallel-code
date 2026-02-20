import { toggleNewTaskDialog, createTerminal } from "../store/store";
import { theme } from "../lib/theme";
import { mod } from "../lib/platform";

export function NewTaskPlaceholder() {
  return (
    <div
      style={{
        width: "48px",
        "min-width": "48px",
        height: "calc(100% - 12px)",
        display: "flex",
        "flex-direction": "column",
        gap: "4px",
        margin: "6px 3px",
        "flex-shrink": "0",
      }}
    >
      {/* Add task button — fills remaining space */}
      <div
        class="new-task-placeholder"
        onClick={() => toggleNewTaskDialog(true)}
        style={{
          flex: "1",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          cursor: "pointer",
          "border-radius": "12px",
          border: `2px dashed ${theme.border}`,
          color: theme.fgSubtle,
          "font-size": "20px",
          "user-select": "none",
        }}
        title={`New task (${mod}+N)`}
      >
        +
      </div>

      {/* Terminal button — square, fixed size */}
      <div
        class="new-task-placeholder"
        onClick={() => createTerminal()}
        style={{
          width: "44px",
          height: "44px",
          display: "flex",
          "align-items": "center",
          "justify-content": "center",
          cursor: "pointer",
          "border-radius": "10px",
          border: `2px dashed ${theme.border}`,
          color: theme.fgSubtle,
          "font-size": "13px",
          "font-family": "monospace",
          "user-select": "none",
          "flex-shrink": "0",
        }}
        title={`New terminal (${mod}+Shift+D)`}
      >
        &gt;_
      </div>
    </div>
  );
}
