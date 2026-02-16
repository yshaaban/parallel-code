use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct Task {
    pub id: String,
    pub name: String,
    pub branch_name: String,
    pub worktree_path: String,
    pub agent_ids: Vec<String>,
    pub status: TaskStatus,
}

#[derive(Clone, Serialize, PartialEq)]
pub enum TaskStatus {
    Active,
    Closed,
}
