import { produce } from "solid-js/store";
import { getLocalDateKey } from "../lib/date";
import { store, setStore } from "./core";

export function recordTaskCompleted(): void {
  const today = getLocalDateKey();
  setStore(
    produce((s) => {
      if (s.completedTaskDate !== today) {
        s.completedTaskDate = today;
        s.completedTaskCount = 1;
        return;
      }
      s.completedTaskCount += 1;
    })
  );
}

export function getCompletedTasksTodayCount(): number {
  return store.completedTaskDate === getLocalDateKey() ? store.completedTaskCount : 0;
}
