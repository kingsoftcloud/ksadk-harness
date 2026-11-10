// Browser entry for the engine's own task view (agentkit.engine-view/v1).
//
// Bundled into one self-contained HTML document that the engine hands to any
// host over the protocol. The host embeds it in a sandboxed iframe and only
// relays engine events; it renders nothing engine-specific itself. Changing
// how a task looks therefore ships with an engine release.
//
// Host -> view messages:  { contract, type: "events", runId, events: EngineEvent[] }
//                         { contract, type: "reset", runId }
//                         { contract, type: "theme", theme: "light" | "dark" | "system" }
// View -> host messages:  { contract, type: "ready", version }
//                         { contract, type: "height", height }
// Messages are accepted only from the embedding parent window.
import React from "react";
import { createRoot } from "react-dom/client";
import { createHarnessComponents } from "../react-binding.mjs";
import { initialState, reduceAll } from "../reducer.mjs";
import { engineEventsToTimeline, ENGINE_VIEW_CONTRACT } from "./adapter.mjs";

const VERSION = globalThis.__ENGINE_VIEW_VERSION__ ?? "dev";
const { HarnessTimeline } = createHarnessComponents(React);
const post = message => { try { window.parent.postMessage({ contract: ENGINE_VIEW_CONTRACT, ...message }, "*"); } catch { /* detached */ } };

function App() {
  const [view, setView] = React.useState({ runId: "run", state: initialState(), theme: "system" });
  React.useEffect(() => {
    const onMessage = message => {
      if (message.source !== window.parent) return;
      const data = message.data;
      if (!data || data.contract !== ENGINE_VIEW_CONTRACT) return;
      if (data.type === "theme" && ["light", "dark", "system"].includes(data.theme)) {
        // The view's text and native controls follow the host's scheme; its background stays transparent.
        document.documentElement.style.colorScheme = data.theme === "system" ? "light dark" : data.theme;
        setView(current => ({ ...current, theme: data.theme }));
      }
      else if (data.type === "reset") setView(current => ({ ...current, runId: String(data.runId || "run"), state: initialState() }));
      else if (data.type === "events" && Array.isArray(data.events)) setView(current => {
        const runId = String(data.runId || current.runId);
        const base = runId === current.runId ? current.state : initialState();
        return { ...current, runId, state: reduceAll(base, engineEventsToTimeline(data.events, { runId })) };
      });
    };
    window.addEventListener("message", onMessage);
    post({ type: "ready", version: VERSION });
    // Measure the content, not the document: the document is never shorter than the iframe, so it could only grow.
    const root = document.getElementById("root");
    const observer = new ResizeObserver(() => post({ type: "height", height: Math.ceil(root.getBoundingClientRect().height) }));
    observer.observe(root);
    return () => { window.removeEventListener("message", onMessage); observer.disconnect(); };
  }, []);
  return React.createElement(HarnessTimeline, { state: view.state, theme: view.theme, autoFollow: false });
}

createRoot(document.getElementById("root")).render(React.createElement(App));
