// Project domain components (SP-3). Lifted from apps/desktop/src/ so apps/web
// can use the same kanban / drawer / modals.
export { ProjectsList, type ProjectListItem, type ProjectHealth } from "./ProjectsList.js";
export { ProjectBoard, STATE_COLOR, STATE_LABEL, StatePill } from "./ProjectBoard.js";
export { TaskDetail } from "./TaskDetail.js";
export { NewProject, type NewProjectDraft, type BrowseEntry, type BrowseResponse } from "./NewProject.js";
export { NewTask, type NewTaskDraft } from "./NewTask.js";
export { ProjectSettings } from "./ProjectSettings.js";
