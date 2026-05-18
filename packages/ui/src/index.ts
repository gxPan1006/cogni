// @cogni/ui — shared React UI for cogni desktop + web.
//
// Components and hooks land here as the apps/desktop → apps/web extraction
// progresses (SP-2 Section 8). See SP-2 plan Tasks 21-24 for the migration order.

// Transport
export { ApiClient, ApiError } from "./transport/api.js";
export type {
  ApiConfig, HostInfo, DeviceRow, IdentityRow,
} from "./transport/api.js";
