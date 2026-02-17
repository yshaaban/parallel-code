use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct WorktreeInfo {
    pub path: String,
    pub branch: String,
}

#[derive(Clone, Serialize)]
pub struct ChangedFile {
    pub path: String,
    pub lines_added: u32,
    pub lines_removed: u32,
    pub status: String,
}
