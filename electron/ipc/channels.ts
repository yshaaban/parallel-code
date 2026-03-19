export enum IPC {
  // Agent/PTY
  SpawnAgent = 'spawn_agent',
  DetachAgentOutput = 'detach_agent_output',
  WriteToAgent = 'write_to_agent',
  ResizeAgent = 'resize_agent',
  PauseAgent = 'pause_agent',
  ResumeAgent = 'resume_agent',
  KillAgent = 'kill_agent',
  GetAgentScrollback = 'get_agent_scrollback',
  GetScrollbackBatch = 'get_scrollback_batch',
  GetTerminalRecoveryBatch = 'get_terminal_recovery_batch',
  CountRunningAgents = 'count_running_agents',
  KillAllAgents = 'kill_all_agents',
  ListAgents = 'list_agents',
  GetAgentSupervision = 'get_agent_supervision',
  AgentSupervisionChanged = 'agent_supervision_changed',
  ListRunningAgentIds = 'list_running_agent_ids',
  GetBackendRuntimeDiagnostics = 'get_backend_runtime_diagnostics',
  ResetBackendRuntimeDiagnostics = 'reset_backend_runtime_diagnostics',
  GetBrowserReconnectSnapshot = 'get_browser_reconnect_snapshot',

  // Task
  CreateTask = 'create_task',
  DeleteTask = 'delete_task',
  GetTaskPorts = 'get_task_ports',
  GetTaskPortExposureCandidates = 'get_task_port_exposure_candidates',
  GetTaskConvergence = 'get_task_convergence',
  GetServerStateBootstrap = 'get_server_state_bootstrap',
  AcquireTaskCommandLease = 'acquire_task_command_lease',
  RenewTaskCommandLease = 'renew_task_command_lease',
  ReleaseTaskCommandLease = 'release_task_command_lease',
  GetTaskCommandControllers = 'get_task_command_controllers',
  ExposePort = 'expose_port',
  RefreshTaskPortPreview = 'refresh_task_port_preview',
  UnexposePort = 'unexpose_port',

  // Git
  GetChangedFiles = 'get_changed_files',
  GetChangedFilesFromBranch = 'get_changed_files_from_branch',
  GetFileDiff = 'get_file_diff',
  GetFileDiffFromBranch = 'get_file_diff_from_branch',
  GetAllFileDiffs = 'get_all_file_diffs',
  GetAllFileDiffsFromBranch = 'get_all_file_diffs_from_branch',
  GetGitignoredDirs = 'get_gitignored_dirs',
  GetWorktreeStatus = 'get_worktree_status',
  CheckMergeStatus = 'check_merge_status',
  MergeTask = 'merge_task',
  GetBranchLog = 'get_branch_log',
  PushTask = 'push_task',
  AskAboutCode = 'ask_about_code',
  CancelAskAboutCode = 'cancel_ask_about_code',
  RebaseTask = 'rebase_task',
  GetMainBranch = 'get_main_branch',
  GetCurrentBranch = 'get_current_branch',
  CommitAll = 'commit_all',
  DiscardUncommitted = 'discard_uncommitted',

  // Persistence
  SaveAppState = 'save_app_state',
  LoadAppState = 'load_app_state',
  SaveWorkspaceState = 'save_workspace_state',
  LoadWorkspaceState = 'load_workspace_state',
  WorkspaceStateChanged = 'workspace_state_changed',
  TaskCommandControllerChanged = 'task_command_controller_changed',

  // Window
  WindowIsFocused = '__window_is_focused',
  WindowIsMaximized = '__window_is_maximized',
  WindowMinimize = '__window_minimize',
  WindowToggleMaximize = '__window_toggle_maximize',
  WindowClose = '__window_close',
  WindowForceClose = '__window_force_close',
  WindowHide = '__window_hide',
  WindowMaximize = '__window_maximize',
  WindowUnmaximize = '__window_unmaximize',
  WindowSetSize = '__window_set_size',
  WindowSetPosition = '__window_set_position',
  WindowGetPosition = '__window_get_position',
  WindowGetSize = '__window_get_size',
  WindowFocus = '__window_focus',
  WindowBlur = '__window_blur',
  WindowResized = '__window_resized',
  WindowMoved = '__window_moved',
  WindowCloseRequested = '__window_close_requested',

  // Dialog
  DialogConfirm = '__dialog_confirm',
  DialogOpen = '__dialog_open',

  // Shell
  ShellReveal = '__shell_reveal',
  ShellOpenFile = '__shell_open_file',
  ShellOpenInEditor = '__shell_open_in_editor',

  // Arena
  SaveArenaData = 'save_arena_data',
  LoadArenaData = 'load_arena_data',
  CreateArenaWorktree = 'create_arena_worktree',
  RemoveArenaWorktree = 'remove_arena_worktree',
  CheckPathExists = 'check_path_exists',
  CheckPathsExist = 'check_paths_exist',

  // Filesystem browsing
  ListDirectory = 'list_directory',
  GetHomePath = 'get_home_path',
  GetRecentProjects = 'get_recent_projects',

  // Remote access
  StartRemoteServer = 'start_remote_server',
  StopRemoteServer = 'stop_remote_server',
  GetRemoteStatus = 'get_remote_status',
  RemoteStatusChanged = 'remote_status_changed',

  // Plan
  PlanContent = 'plan_content',
  ReadPlanContent = 'read_plan_content',

  // Notifications
  ShowNotification = 'show_notification',
  NotificationClicked = 'notification_clicked',

  // Git notifications
  GitStatusChanged = 'git_status_changed',
  TaskReviewChanged = 'task_review_changed',
  TaskPortsChanged = 'task_ports_changed',
  TaskConvergenceChanged = 'task_convergence_changed',

  // Review
  GetProjectDiff = 'get_project_diff',
}
