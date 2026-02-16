pub mod types;

use crate::state::AppState;
use types::AgentDef;

#[tauri::command]
pub fn list_agents(state: tauri::State<'_, AppState>) -> Vec<AgentDef> {
    state.agents.clone()
}
