use parking_lot::Mutex;
use std::collections::HashMap;

use crate::agents::types::AgentDef;
use crate::pty::types::PtySession;
use crate::tasks::types::Task;

pub struct AppState {
    pub sessions: Mutex<HashMap<String, PtySession>>,
    pub tasks: Mutex<HashMap<String, Task>>,
    pub agents: Vec<AgentDef>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            sessions: Mutex::new(HashMap::new()),
            tasks: Mutex::new(HashMap::new()),
            agents: AgentDef::defaults(),
        }
    }
}
