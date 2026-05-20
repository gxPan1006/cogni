// @cogni/ui — shared React UI for cogni desktop + web.
//
// Components and hooks land here as the apps/desktop → apps/web extraction
// progresses (SP-2 Section 8). See SP-2 plan Tasks 21-24 for the migration order.

// Transport
export { ApiClient, ApiError } from "./transport/api.js";
export type {
  ApiConfig, HostInfo, DeviceRow, IdentityRow,
  CreateProjectInput, UpdateProjectInput, CreateTaskInput, TaskDetailResponse,
} from "./transport/api.js";

// Hooks
export { useThreadStream } from "./hooks/useThreadStream.js";
export { useAuthCore } from "./hooks/useAuth-core.js";
export { useDevices } from "./hooks/useDevices.js";
export { useIdentities } from "./hooks/useIdentities.js";
export { useHosts } from "./hooks/useHosts.js";
export { useProjects, applyProjectEvent } from "./hooks/useProjects.js";
export { useProjectBoard, applyTaskEvent } from "./hooks/useProjectBoard.js";
export { useTaskDetail } from "./hooks/useTaskDetail.js";

// Components (chat core — used by desktop today, web in SP-2 batch 4)
export { Sidebar } from "./components/Sidebar.js";
export { Conversation } from "./components/Conversation.js";
export { Composer } from "./components/Composer.js";
export { Welcome } from "./components/Welcome.js";
export { Login } from "./components/Login.js";
export { Icon } from "./components/icons.js";
export { LogoMark } from "./components/LogoMark.js";
export { HostFallbackCard } from "./components/HostFallbackCard.js";
export { NoHostBanner } from "./components/NoHostBanner.js";
export { SettingsPage } from "./components/SettingsPage.js";

// Lower-level chat building blocks (Conversation composes them; apps that
// want to render messages outside of Conversation can use them directly)
export {
  UserMessage, AssistantText, AssistantBlocks, ThinkingBlock, ToolCallBlock, PermissionPrompt,
  aggregateEvents, buildTimeline,
} from "./components/ChatBlocks.js";
export { Markdown } from "./components/Markdown.js";

// SP-3 project domain components (apps/desktop + apps/web share these)
export {
  ProjectsList,
  ProjectBoard, STATE_COLOR, STATE_LABEL, StatePill,
  TaskDetail,
  NewProject, NewTask,
  ProjectSettings,
  ArtifactBrowser,
} from "./components/project/index.js";
export type {
  ProjectListItem, ProjectHealth,
  NewProjectDraft, NewTaskDraft,
  BrowseEntry, BrowseResponse,
  ArtifactSource,
} from "./components/project/index.js";

// SP-4 workspace chat orchestrator. `scopePlaceholder` + `WorkspaceChatScope`
// are shared; the draggable <ChatBubble> is the live entry point on the project
// page (it superseded the bottom-anchored <WorkspaceChatBar>).
export { WorkspaceChatBar, scopePlaceholder } from "./components/project/WorkspaceChatBar.js";
export type { WorkspaceChatScope } from "./components/project/WorkspaceChatBar.js";
export { ChatBubble } from "./components/project/chat-bubble/ChatBubble.js";
