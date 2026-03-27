// Barrel file — re-exports from domain modules
export { store } from './core';
export {
  getProject,
  addProject,
  removeProject,
  updateProject,
  getProjectPath,
  getProjectBaseBranch,
  getProjectBranchPrefix,
  validateProjectPaths,
  setProjectPath,
  clearMissingProject,
  isProjectMissing,
  PASTEL_HUES,
} from './projects';
export {
  addAgentToTask,
  markAgentExited,
  markAgentRunning,
  setAgentStatus,
  restartAgent,
  switchAgent,
} from './agents';
export {
  updateTaskName,
  updateTaskNotes,
  setLastPrompt,
  clearInitialPrompt,
  clearPrefillPrompt,
  setPrefillPrompt,
  reorderTask,
  reorderTaskWithinSidebarGroup,
  hasDirectModeTask,
  getGitHubDropDefaults,
  setNewTaskDropUrl,
  setNewTaskPrefillPrompt,
  setPlanContent,
} from './tasks';
export {
  setActiveTask,
  setActiveAgent,
  navigateTask,
  navigateAgent,
  moveActiveTask,
  toggleNewTaskDialog,
} from './navigation';
export {
  registerFocusFn,
  unregisterFocusFn,
  triggerFocus,
  registerAction,
  unregisterAction,
  triggerAction,
  getSidebarRestoreTaskActionKey,
  getTaskFocusedPanel,
  getStoredTaskFocusedPanel,
  isTaskPanelFocused,
  setTaskFocusedPanelState,
  setTaskFocusedPanel,
  focusSidebar,
  unfocusSidebar,
  unfocusPlaceholder,
  navigateRow,
  navigateColumn,
  setPendingAction,
  clearPendingAction,
  toggleHelpDialog,
  toggleSettingsDialog,
  sendActivePrompt,
  setSidebarFocusedProjectId,
} from './focus';
export {
  getPeerDisplayName,
  getPeerViewerCountForTask,
  getPeerSession,
  listPeerSessions,
  replacePeerSessions,
} from './peer-presence';
export {
  applyTaskCommandControllerChanged,
  getTaskCommandOwnerStatus,
  getTaskCommandControllerUpdateCount,
  getTaskCommandController,
  getPeerTaskCommandController,
  getPeerTaskCommandControlMessage,
  getPeerTaskCommandControlStatus,
  isTaskCommandControlledByPeer,
  loadTaskCommandControllers,
  replaceTaskCommandControllers,
} from './task-command-controllers';
export {
  clearIncomingTaskTakeoverRequest,
  getIncomingTaskTakeoverRequest,
  listIncomingTaskTakeoverRequests,
  upsertIncomingTaskTakeoverRequest,
} from './task-command-takeovers';
export type { PanelId, PendingAction } from './types';
export {
  applyLoadedStateJson,
  applyLoadedWorkspaceStateJson,
  loadState,
  loadWorkspaceState,
  saveBrowserWorkspaceState,
  saveCurrentRuntimeState,
  saveState,
} from './persistence';
export {
  loadClientSessionState,
  reconcileClientSessionState,
  saveClientSessionState,
} from './client-session';
export {
  getFontScale,
  adjustFontScale,
  resetFontScale,
  getGlobalScale,
  adjustGlobalScale,
  resetGlobalScale,
  getPanelSize,
  setPanelSizes,
  toggleSidebar,
  toggleArena,
  setTerminalFont,
  setThemePreset,
  setAutoTrustFolders,
  setShowPlans,
  setTerminalHighLoadMode,
  setTaskNotificationsEnabled,
  setInactiveColumnOpacity,
  setEditorCommand,
  setHydraForceDispatchFromPromptPanel,
  setHydraStartupMode,
  setWindowState,
} from './ui';
export {
  getTaskActivityStatus,
  getTaskActivityStatusLabel,
  getTaskDotStatus,
  markAgentOutput,
  clearAgentBusyState,
  clearAgentActivity,
  getAgentOutputTail,
  stripAnsi,
  onAgentReady,
  offAgentReady,
  normalizeForComparison,
  looksLikeQuestion,
  isTrustQuestionAutoHandled,
  isAutoTrustSettling,
  hasReadyPromptInTail,
  isAgentAskingQuestion,
} from './taskStatus';
export type { TaskActivityStatus, TaskDotStatus } from './taskStatus';
export { getRecentTaskGitStatusPollAge } from './task-git-status';
export { showNotification, clearNotification } from './notification';
export { getCompletedTasksTodayCount, getMergedLineTotals } from './completion';
export {
  createTerminal,
  closeTerminal,
  updateTerminalName,
  syncTerminalCounter,
} from './terminals';
export {
  addPermissionRequest,
  resolvePermission,
  expirePermissions,
  addPermissionAutoRule,
  clearPermissionRequests,
  addReviewComment,
  updateReviewComment,
  removeReviewComment,
  markCommentsSent,
  markCommentsStale,
  setReviewPanelOpen,
} from './review';
export type {
  PermissionRequest,
  PermissionAutoRule,
  DiffComment,
  DiffLineAnchor,
  ReviewDiffMode,
} from './types';
