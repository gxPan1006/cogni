// @cogni/ui — shared React UI for cogni desktop + web.
//
// Components and hooks land here as the apps/desktop → apps/web extraction
// progresses (SP-2 Section 8). See SP-2 plan Tasks 21-24 for the migration order.

// Transport
export { ApiClient, ApiError } from "./transport/api.js";
export type {
  ApiConfig, HostInfo, DeviceRow, IdentityRow,
} from "./transport/api.js";

// Hooks
export { useThreadStream } from "./hooks/useThreadStream.js";
export { useAuthCore } from "./hooks/useAuth-core.js";

// Components (chat core — used by desktop today, web in SP-2 batch 4)
export { Sidebar } from "./components/Sidebar.js";
export { Conversation } from "./components/Conversation.js";
export { Composer } from "./components/Composer.js";
export { Welcome } from "./components/Welcome.js";
export { Login } from "./components/Login.js";
export { Icon } from "./components/icons.js";
export { LogoMark } from "./components/LogoMark.js";

// Lower-level chat building blocks (Conversation composes them; apps that
// want to render messages outside of Conversation can use them directly)
export {
  UserMessage, AssistantText, ToolCallBlock, PermissionPrompt, aggregateEvents,
} from "./components/ChatBlocks.js";
export { Markdown } from "./components/Markdown.js";
