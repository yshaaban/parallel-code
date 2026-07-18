// Barrel file — re-exports from domain modules
export { store } from './core';
export {
  clampTerminalFontSize,
  DEFAULT_FONT_SMOOTHING,
  DEFAULT_TERMINAL_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from './terminal-font-settings';
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
export { getProjectMode, isGitProject, isNonGitProject } from './project-mode';
export {
  addAgentToTask,
  clearAgentTerminalSessionReplacement,
  closeAgentInTask,
  getAgentTerminalSessionVersion,
  markAgentExited,
  markAgentRunning,
  setAgentStatus,
  restartAgent,
  switchAgent,
} from './agents';
export {
  getSelectedTaskAgentId,
  getSelectedTaskRuntimeAgentId,
  isTaskAiAgentId,
  isTaskRuntimeAgentId,
} from './task-agent-selection';
export {
  getTaskTerminalLayoutMode,
  getTaskVisibleAiTerminalAgentIds,
  setTaskTerminalLayoutMode,
} from './task-terminal-layout';
export {
  updateTaskName,
  updateTaskNotes,
  setLastPrompt,
  clearInitialPrompt,
  clearPrefillPrompt,
  setPrefillPrompt,
  reorderTask,
  reorderTaskWithinSidebarGroup,
  hasCurrentBranchTask,
  getGitHubDropDefaults,
  setNewTaskDropUrl,
  setNewTaskPrefillPrompt,
  setPlanContent,
} from './tasks';
export {
  setActiveTask,
  setActiveAgent,
  navigateAgent,
  moveActiveTask,
  jumpToTask,
  toggleNewTaskDialog,
  toggleAddProjectDialog,
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
  navigateTask,
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
  getTaskCommandControllerVersion,
  getTaskCommandController,
  getPeerTaskCommandController,
  getPeerTaskCommandControlMessage,
  getPeerTaskCommandControlStatus,
  isTaskCommandControlledByPeer,
  loadTaskCommandControllers,
  replaceTaskCommandControllers,
} from './task-command-controllers';
export {
  applyCoordinatorEvent,
  getCoordinatorRun,
  getCoordinatorRunForTask,
  replaceCoordinatorSnapshot,
} from './coordinator';
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
  setTerminalFontSize,
  setFontSmoothing,
  setThemePreset,
  setAutoTrustFolders,
  setShowPlans,
  setTerminalHighLoadMode,
  setTerminalLocalInputFeedbackEnabled,
  setTaskNotificationsEnabled,
  setVerboseLogging,
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
export { getMergedTasksTodayCount, getMergedLineTotals } from './completion';
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
