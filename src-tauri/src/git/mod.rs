pub mod types;

use std::process::Command;

use crate::error::AppError;
use types::{ChangedFile, WorktreeInfo};

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

#[tauri::command]
pub fn get_changed_files(worktree_path: String) -> Result<Vec<ChangedFile>, AppError> {
    let mut files: Vec<ChangedFile> = Vec::new();

    // git status --porcelain to get file statuses
    let status_output = Command::new("git")
        .args(["status", "--porcelain"])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    let status_str = String::from_utf8_lossy(&status_output.stdout);

    // Parse statuses into a map: path -> status letter
    let mut status_map = std::collections::HashMap::new();
    for line in status_str.lines() {
        if line.len() < 3 {
            continue;
        }
        let xy = &line[..2];
        let path = line[3..].trim_start().to_string();
        // Use index status if set, otherwise worktree status
        let status = if xy.starts_with('?') {
            "?".to_string()
        } else {
            let ch = xy.chars().next().unwrap_or(' ');
            if ch != ' ' {
                ch.to_string()
            } else {
                xy.chars().nth(1).unwrap_or('M').to_string()
            }
        };
        status_map.insert(path, status);
    }

    // git diff --numstat HEAD to get line counts
    let diff_output = Command::new("git")
        .args(["diff", "--numstat", "HEAD"])
        .current_dir(&worktree_path)
        .output()
        .map_err(|e| AppError::Git(e.to_string()))?;

    let diff_str = String::from_utf8_lossy(&diff_output.stdout);
    let mut seen = std::collections::HashSet::new();

    for line in diff_str.lines() {
        let parts: Vec<&str> = line.split('\t').collect();
        if parts.len() < 3 {
            continue;
        }
        let added = parts[0].parse::<u32>().unwrap_or(0);
        let removed = parts[1].parse::<u32>().unwrap_or(0);
        let path = parts[2].to_string();
        let status = status_map.get(&path).cloned().unwrap_or_else(|| "M".to_string());
        seen.insert(path.clone());
        files.push(ChangedFile {
            path,
            lines_added: added,
            lines_removed: removed,
            status,
        });
    }

    // Add untracked files not in diff output
    for (path, status) in &status_map {
        if !seen.contains(path) {
            files.push(ChangedFile {
                path: path.clone(),
                lines_added: 0,
                lines_removed: 0,
                status: status.clone(),
            });
        }
    }

    files.sort_by(|a, b| a.path.cmp(&b.path));
    Ok(files)
}
