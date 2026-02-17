use notify::RecommendedWatcher;
use parking_lot::Mutex;
use std::collections::HashMap;

use crate::agents::types::AgentDef;
use crate::pty::types::PtySession;
use crate::tasks::types::Task;

pub struct AppState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    pub tasks: Mutex<HashMap<String, Task>>,
    pub agents: Vec<AgentDef>,
    pub watchers: Mutex<HashMap<String, RecommendedWatcher>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            agents: AgentDef::defaults(),
            watchers: Mutex::new(HashMap::new()),
        }
    }
}
