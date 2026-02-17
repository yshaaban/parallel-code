use std::path::PathBuf;
use std::sync::Arc;
use std::time::Instant;

use notify::{Event, EventKind, RecursiveMode, Watcher};
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::error::AppError;
use crate::state::AppState;

#[derive(Clone, Serialize)]
struct PlanDetectedPayload {
    task_id: String,
    file_path: String,
    file_name: String,
}

#[tauri::command]
pub fn watch_for_plans(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    watch_path: String,
) -> Result<(), AppError> {
    let plans_dir = PathBuf::from(&watch_path).join(".claude").join("plans");
    std::fs::create_dir_all(&plans_dir).map_err(|e| AppError::Watcher(e.to_string()))?;

    let task_id_clone = task_id.clone();
    let last_event: Arc<Mutex<Instant>> =
        Arc::new(Mutex::new(Instant::now() - std::time::Duration::from_secs(10)));

    let watcher = notify::recommended_watcher(move |res: Result<Event, notify::Error>| {
        let event = match res {
            Ok(e) => e,
            Err(_) => return,
        };

        let is_relevant = matches!(
            event.kind,
            EventKind::Create(_) | EventKind::Modify(_)
        );
        if !is_relevant {
            return;
        }

        // Debounce: ignore events within 1s of last emitted event
        {
            let mut last = last_event.lock();
            let now = Instant::now();
            if now.duration_since(*last).as_millis() < 1000 {
                return;
            }
            *last = now;
        }

        for path in &event.paths {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            if ext != "md" {
                continue;
            }

            let file_name = path
                .file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("plan.md")
                .to_string();

            let payload = PlanDetectedPayload {
                task_id: task_id_clone.clone(),
                file_path: path.to_string_lossy().to_string(),
                file_name,
            };

            let _ = app.emit("plan-detected", payload);
        }
    })
    .map_err(|e| AppError::Watcher(e.to_string()))?;

    let mut watcher = watcher;
    watcher
        .watch(&plans_dir, RecursiveMode::NonRecursive)
        .map_err(|e| AppError::Watcher(e.to_string()))?;

    state.watchers.lock().insert(task_id, watcher);
    Ok(())
}

#[tauri::command]
pub fn stop_watching_plans(state: State<'_, AppState>, task_id: String) -> Result<(), AppError> {
    state.watchers.lock().remove(&task_id);
    Ok(())
}

#[tauri::command]
pub fn read_plan_file(path: String) -> Result<String, AppError> {
    std::fs::read_to_string(&path).map_err(|e| AppError::Watcher(e.to_string()))
}

#[tauri::command]
pub fn write_plan_file(path: String, content: String) -> Result<(), AppError> {
    std::fs::write(&path, &content).map_err(|e| AppError::Watcher(e.to_string()))
}
