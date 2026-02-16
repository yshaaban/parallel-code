use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
}
