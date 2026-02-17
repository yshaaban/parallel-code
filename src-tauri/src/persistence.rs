use std::fs;
use std::path::PathBuf;
use tauri::Manager;

use crate::error::AppError;

fn state_file_path(app: &tauri::AppHandle) -> Result<PathBuf, AppError> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| AppError::Git(format!("Failed to resolve app data dir: {}", e)))?;
    Ok(dir.join("state.json"))
}

#[tauri::command]
pub fn save_app_state(app: tauri::AppHandle, json: String) -> Result<(), AppError> {
    let path = state_file_path(&app)?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    fs::write(&path, json)?;
    Ok(())
}

#[tauri::command]
pub fn load_app_state(app: tauri::AppHandle) -> Result<Option<String>, AppError> {
    let path = state_file_path(&app)?;
    if !path.exists() {
        return Ok(None);
    }
    let content = fs::read_to_string(&path)?;
    Ok(Some(content))
}
