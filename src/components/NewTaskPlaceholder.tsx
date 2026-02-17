import { toggleNewTaskDialog } from "../store/store";
import { theme } from "../lib/theme";

export function NewTaskPlaceholder() {
  return (
    <div
      class="new-task-placeholder"
      onClick={() => toggleNewTaskDialog(true)}
      style={{
        width: "48px",
        "min-width": "48px",
        height: "100%",
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        cursor: "pointer",
        "border-radius": "12px",
        border: `2px dashed ${theme.border}`,
        margin: "6px 3px",
        color: theme.fgSubtle,
        "font-size": "20px",
        "user-select": "none",
        "flex-shrink": "0",
      }}
      title="New task (Ctrl+N)"
    >
      +
    </div>
  );
}
