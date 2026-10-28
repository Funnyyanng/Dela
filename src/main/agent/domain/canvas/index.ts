import type { AgentTool } from '../shared';
import { listCanvasCoursesTool } from './list-courses';
import { refreshCanvasCourseTool } from './refresh-course';
import { refreshCanvasCoursesTool } from './refresh-courses';
import { searchCanvasSourcesTool } from './search-sources';
import { getCanvasStatusTool } from './status';
import { localCanvasStatusTool, syncLocalCanvasTool } from './local-sync';

export const canvasTools = {
  get_canvas_status: getCanvasStatusTool,
  list_canvas_courses: listCanvasCoursesTool,
  search_canvas_sources: searchCanvasSourcesTool,
  refresh_canvas_courses: refreshCanvasCoursesTool,
  refresh_canvas_course: refreshCanvasCourseTool,
  get_local_canvas_status: localCanvasStatusTool,
  sync_local_canvas: syncLocalCanvasTool,
} satisfies Record<string, AgentTool>;
