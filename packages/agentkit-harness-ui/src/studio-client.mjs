// This is the versioned browser integration used by Studio's Harness plugin.
export const contract = 'agentkit.studio-harness-ui/v1';
export const version = globalThis.__STUDIO_HARNESS_UI_VERSION__;
export { installTaskTimeline } from './host/task-timeline.mjs';
export { createNativeChildPanel } from './host/native-run-panel.mjs';
