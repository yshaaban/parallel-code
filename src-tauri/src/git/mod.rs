pub mod types;

use std::process::Command;

use crate::error::AppError;
use types::WorktreeInfo;

pub fn create_worktree(
    repo_root: &str,
    branch_name: &str,
) -> Result<WorktreeInfo, AppError> {
    let worktree_path = format!("{}/.worktrees/{}", repo_root, branch_name);

    // Create the branch (ignore error if it already exists)
    let _ = Command::new("git")
        .args(["branch", branch_name])
        .current_dir(repo_root)
        .output();

    // Create the worktree
    let output = Command::new("git")
        .args(["worktree", "add", &worktree_path, branch_name])
        .current_dir(repo_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Git(format!(
            "Failed to create worktree: {}",
            stderr
        )));
    }

    Ok(WorktreeInfo {
        path: worktree_path,
        branch: branch_name.to_string(),
    })
}

pub fn remove_worktree(
    repo_root: &str,
    branch_name: &str,
    delete_branch: bool,
) -> Result<(), AppError> {
    let worktree_path = format!("{}/.worktrees/{}", repo_root, branch_name);

    let output = Command::new("git")
        .args(["worktree", "remove", "--force", &worktree_path])
        .current_dir(repo_root)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Git(format!(
            "Failed to remove worktree: {}",
            stderr
        )));
    }

    if delete_branch {
        let _ = Command::new("git")
            .args(["branch", "-D", branch_name])
            .current_dir(repo_root)
            .output();
    }

    Ok(())
}
