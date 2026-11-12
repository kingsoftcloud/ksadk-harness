// @kingsoftcloud/agentkit-harness-ui — React binding
//
// Thin adapter over the pure view model. All rendering logic lives in
// view.mjs + renderers.mjs; this module maps the plain element tree to
// React.createElement and owns the presentation-only state the view needs:
//  - which thoughts/tools are expanded (never written back to reducer state)
//  - desktop thought auto-collapse: a thought that stops streaming collapses
//    back to its summary UNLESS the user opened it themselves
//  - scroll-reader preservation: streaming thought bodies and execute output
//    auto-follow the bottom, pause when the user scrolls up, and resume when
//    they scroll back — matching the desktop reasoning/execute viewports
//  - the streaming latest-line summary scrolls to its trailing edge
//
// Host actions (open file, copy, open terminal, retrieve full diff, jump to
// latest) are carried as `data-action` attributes on the function-free tree and
// dispatched from a single delegated click handler on the root, so the view
// stays serializable and testable with node:test.
//
// React is a peer dependency. The pure modules do not import React and run in
// plain Node.

import { buildViewModel } from "./view.mjs";
import { styles } from "./styles.mjs";
import { visibleItems } from "./project.mjs";

import { createSummaryPlayback } from './summary-playback.mjs';

const FOLLOW_THRESHOLD_PX = 8;

/**
 * Stateful React timeline. Presentation-only state (expanded thoughts/tools,
 * follow flag) is never written back to the reducer state.
 *
 * @param {{
 *   state: object,
 *   className?: string,
 *   workspaceRoot?: string,
 *   labels?: object,
 *   renderText?: (text: string, meta: {streaming: boolean}) => ReactNode,
 *   initiallyExpandedThoughts?: string[],
 *   initiallyExpandedTools?: string[],
 *   autoFollow?: boolean,
 *   styleSheet?: string | null,
 *   onJumpLatest?: () => void,
 *   onOpenFile?: (target: {path: string, kind: string, callId?: string}) => void,
 *   onCopy?: (text: string) => void,
 *   onOpenTerminal?: (target: {callId: string, cwd?: string}) => void,
 *   onRetrieveFullDiff?: (target: {callId: string, path: string}) => void,
 * }} props
 */
// ── scroll mask helpers (reasoning.tsx / scrollMask.ts semantics) ───────────
// Pure functions over scroll metrics so the mask state is testable without a
// DOM. The mask itself is a static linear-gradient (no motion), so it stays
// under prefers-reduced-motion; only the auto-follow pin is direct (never
// smooth), satisfying reduced-motion there too.
const MASK_EDGE_PX = 24;
const MASK_THRESHOLD_PX = 1;

/** Resolve the top/bottom fade-mask state for a vertical scroll viewport. */
export function resolveVerticalMaskState({ clientHeight, scrollHeight, scrollTop }, previous) {
  const maxScrollTop = Math.max(0, scrollHeight - clientHeight);
  const next = {
    showTop: maxScrollTop > MASK_THRESHOLD_PX && scrollTop > MASK_THRESHOLD_PX,
    showBottom: maxScrollTop > MASK_THRESHOLD_PX && scrollTop < maxScrollTop - MASK_THRESHOLD_PX,
  };
  return previous?.showTop === next.showTop && previous?.showBottom === next.showBottom ? previous : next;
}

/** CSS mask-image style for the vertical (reasoning body) fade. */
export function verticalMaskStyle({ showTop, showBottom }) {
  if (!showTop && !showBottom) return undefined;
  const topStop = showTop
    ? `transparent 0px, black ${MASK_EDGE_PX}px`
    : `black 0px, black ${MASK_EDGE_PX}px`;
  const bottomStop = showBottom
    ? `black calc(100% - ${MASK_EDGE_PX}px), transparent 100%`
    : `black calc(100% - ${MASK_EDGE_PX}px), black 100%`;
  const image = `linear-gradient(to bottom, ${topStop}, ${bottomStop})`;
  return { WebkitMaskImage: image, maskImage: image, WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat", WebkitMaskSize: "100% 100%", maskSize: "100% 100%" };
}

/** CSS mask-image style for the horizontal (streaming summary) fade. */
export function horizontalMaskStyle(overflowing) {
  if (!overflowing) return undefined;
  const image = "linear-gradient(to right, transparent 0, black 16px, black calc(100% - 16px), transparent 100%)";
  return { WebkitMaskImage: image, maskImage: image, WebkitMaskRepeat: "no-repeat", maskRepeat: "no-repeat", WebkitMaskSize: "100% 100%", maskSize: "100% 100%" };
}

export function createHarnessComponents(React) {
  const { createElement, useState, useCallback, useRef, useEffect, useMemo, Fragment } = React;

  function HarnessTimeline(props) {
    const {
      state, className, workspaceRoot, labels, locale, showPlanDock, theme = "system", renderText, initiallyExpandedThoughts,
      initiallyExpandedTools, autoFollow, styleSheet, onJumpLatest, onOpenFile, onCopy,
      onOpenTerminal, onRetrieveFullDiff, onInspectTool, onOpenSubagent,
    } = props || {};
    const [thoughtOpen, setThoughtOpen] = useState(() => new Map((initiallyExpandedThoughts || []).map(id => [id, true])));
    const [toolOpen, setToolOpen] = useState(() => new Map((initiallyExpandedTools || []).map(id => [id, true])));
    const [historyOpen, setHistoryOpen] = useState(() => new Map());
    const [following, setFollowing] = useState(true);
    const [reducedMotion, setReducedMotion] = useState(false);
    const scrollRef = useRef(null);
    const userToggledThoughts = useRef(new Set());
    const prevStreaming = useRef(new Map());

    // prefers-reduced-motion: the reasoning scroll-follow keeps pinning to the
    // bottom (direct scrollTop, never smooth), and the fade masks stay (they
    // are static gradients, not motion). We only record the preference so the
    // tree can expose it for CSS and skip any motion-only flourishes.
    useEffect(() => {
      if (typeof window !== "object" || typeof window.matchMedia !== "function") return;
      const query = window.matchMedia("(prefers-reduced-motion: reduce)");
      const update = () => setReducedMotion(Boolean(query.matches));
      update();
      if (typeof query.addEventListener === "function") {
        query.addEventListener("change", update);
        return () => query.removeEventListener("change", update);
      }
      query.addListener(update);
      return () => query.removeListener(update);
    }, []);

    // Root auto-follow: stay pinned to the bottom while streaming, surface a
    // jump button when the user scrolls up. Opt-in via `autoFollow`.
    useEffect(() => {
      if (!autoFollow) return;
      const node = scrollRef.current;
      if (!node || typeof node.addEventListener !== "function") return;
      const onScroll = () => {
        const atBottom = node.scrollHeight - node.scrollTop - node.clientHeight < FOLLOW_THRESHOLD_PX;
        setFollowing(atBottom);
      };
      node.addEventListener("scroll", onScroll, { passive: true });
      return () => node.removeEventListener("scroll", onScroll);
    }, [autoFollow]);

    useEffect(() => {
      if (autoFollow && following && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    }, [state, following, autoFollow]);

    // Desktop thought auto-collapse: when a thought transitions streaming → done
    // and the user has NOT manually toggled it, collapse it back to the summary.
    // A thought the user opened themselves stays open. This runs after each state
    // update, reconciling thoughtOpen from the observed streaming history.
    useEffect(() => {
      const items = visibleItems(state);
      const next = new Map(thoughtOpen);
      let changed = false;
      for (const item of items) {
        if (item.kind !== "thought") continue;
        const was = prevStreaming.current.get(item.id) ?? false;
        const now = Boolean(item.streaming);
        if (was && !now && !userToggledThoughts.current.has(item.id)) {
          if (next.get(item.id) !== false) { next.set(item.id, false); changed = true; }
        }
        prevStreaming.current.set(item.id, now);
      }
      if (changed) setThoughtOpen(next);
    }, [state, thoughtOpen]);

    // Delegated click handler on the root. `<details>` fires `toggle`; button
    // clicks bubble to `click`. The view tree carries no functions.
    const handleClick = useCallback((event) => {
      const target = event.target;
      if (!target || !target.closest) return;
      // Host action buttons carry data-action.
      const actionEl = target.closest("[data-action]");
      if (actionEl) {
        const action = actionEl.getAttribute("data-action");
        if (action === "jump-latest") {
          if (onJumpLatest) onJumpLatest();
          else if (scrollRef.current) {
            scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
            setFollowing(true);
          }
          return;
        }
        if (action === "open-file" && onOpenFile) {
          onOpenFile({
            path: actionEl.getAttribute("data-path") || "",
            kind: actionEl.getAttribute("data-kind") || "file",
            callId: actionEl.getAttribute("data-call-id") || undefined,
          });
          return;
        }
        if (action === "copy" && onCopy) {
          onCopy(actionEl.getAttribute("data-copy-text") || "");
          return;
        }
        if (action === "open-terminal" && onOpenTerminal) {
          onOpenTerminal({
            callId: actionEl.getAttribute("data-call-id") || "",
            cwd: actionEl.getAttribute("data-cwd") || undefined,
          });
          return;
        }
        if (action === "retrieve-diff" && onRetrieveFullDiff) {
          onRetrieveFullDiff({
            callId: actionEl.getAttribute("data-call-id") || "",
            path: actionEl.getAttribute("data-path") || "",
          });
          return;
        }
        if (action === 'open-subagent' && onOpenSubagent) {
          const callId = actionEl.getAttribute('data-call-id');
          const child = state.items.find(item => item.callId === callId)?.child;
          if (child) onOpenSubagent({ callId, ...child });
          return;
        }
        if (action === "inspect-tool" && onInspectTool) {
          onInspectTool({ callId: actionEl.getAttribute("data-call-id") || "" });
          return;
        }
      }
      // Disclosure toggles (thought/tool summaries).
      const history = target.closest('summary[data-testid="work-history-toggle"]');
      if (history) {
        event.preventDefault(); const details = history.parentElement, id = details.getAttribute('data-item-id');
        setHistoryOpen(previous => new Map(previous).set(id, !details.open)); return;
      }
      const summary = target.closest('summary[data-testid="thought-toggle"], summary[data-testid="tool-toggle"]');
      if (summary) {
        const details = summary.parentElement;
        const itemId = details.getAttribute("data-item-id");
        const callId = details.getAttribute("data-call-id");
        event.preventDefault();
        if (itemId) {
          userToggledThoughts.current.add(itemId);
          setThoughtOpen(prev => { const m = new Map(prev); m.set(itemId, !details.open); return m; });
        } else if (callId) {
          setToolOpen(prev => { const m = new Map(prev); m.set(callId, !details.open); return m; });
        }
      }
    }, [state, onJumpLatest, onOpenFile, onCopy, onOpenTerminal, onRetrieveFullDiff, onInspectTool, onOpenSubagent]);

    const rootProps = {
      ref: scrollRef,
      onClick: handleClick,
      className: className ? `harness-timeline-shell ${className}` : "harness-timeline-shell",
      "data-reduced-motion": reducedMotion ? "true" : "false",
      "data-theme": theme,
    };
    const callbacks = useMemo(() => ({ onOpenFile, onCopy, onOpenTerminal, onRetrieveFullDiff, onInspectTool, onOpenSubagent }),
      [onOpenFile, onCopy, onOpenTerminal, onRetrieveFullDiff, onInspectTool, onOpenSubagent]);
    // Tool view trees contain action descriptors, not callback closures. Stable
    // completed items can retain both their parsed view and React subtree while
    // the live tail changes. Disclosure and presentation options invalidate it.
    const toolViewCache = useMemo(() => new WeakMap(), [toolOpen, labels, locale, workspaceRoot,
      Boolean(onOpenFile), Boolean(onCopy), Boolean(onOpenTerminal), Boolean(onRetrieveFullDiff), Boolean(onInspectTool), Boolean(onOpenSubagent)]);
    const toolElementCache = useMemo(() => new WeakMap(), [toolViewCache, reducedMotion]);
    const tree = buildViewModel(state, {
      thoughtOpen, toolOpen, historyOpen, labels, locale, showPlanDock, workspaceRoot, following, rootProps, toolViewCache, ...callbacks,
    });
    const rendered = renderTree(tree, renderText, callbacks, React, reducedMotion, toolElementCache);
    if (styleSheet === null) return rendered;
    return createElement(Fragment, null,
      createElement("style", { "data-harness-ui": true }, styleSheet === undefined ? styles : styleSheet),
      rendered);
  }


/**
 * Recursively map a plain view-model node to a React element. Nodes that own
 * scroll-reader behavior (streaming thought bodies, execute output, streaming
 * summary) are wrapped in small behavior components that attach their own
 * refs/effects; everything else maps straight through.
 */
function renderTree(node, renderText, callbacks, React, reducedMotion, toolElementCache) {
  if (node == null || node === false) return null;
  if (typeof node !== "object") return node;
  const { createElement } = React;
  const testid = node.props?.["data-testid"];
  const props = node.props || {};
  if (testid === 'tool-block' && toolElementCache?.has(node)) return toolElementCache.get(node);

  if (testid === "execute-command") {
    return createElement(CommandBox, {
      key: props["data-call-id"], type: node.type, props,
      renderChildren: (node.children || []).map(c => renderTree(c, renderText, callbacks, React, reducedMotion, toolElementCache)),
    });
  }

  // Streaming thought body: auto-follow bottom, pause on user scroll-up, and
  // apply a vertical fade mask (top/bottom) when content overflows — matches
  // the desktop reasoning content viewport (reasoning.tsx + scrollMask).
  if (testid === "thought-body") {
    return createElement(FollowBox, {
      key: props["data-item-id"],
      streaming: props["data-streaming"] === "true",
      axis: "vertical",
      mask: "vertical",
      reducedMotion,
      renderChildren: (node.children || []).map(c => renderTree(c, renderText, callbacks, React, reducedMotion, toolElementCache)),
      type: node.type,
      props: node.props,
    });
  }
  // Execute output: same auto-follow/freeze semantics while streaming.
  if (testid === "bash-output-preview-full" || testid === "bash-result-output") {
    return createElement(FollowBox, {
      key: props["data-call-id"] || testid,
      streaming: props["data-streaming"] === "true",
      axis: "vertical",
      freezeWhileReading: true,
      mask: "vertical",
      renderChildren: (node.children || []).map(c => renderTree(c, renderText, callbacks, React, reducedMotion, toolElementCache)),
      type: node.type,
      props: node.props,
    });
  }
  // Streaming latest-line summary: keep the trailing edge in view as it grows
  // and apply a horizontal fade mask when the single line overflows its track.
  if (testid === "thought-preview") {
    return createElement(ScrollEnd, {
      key: props["data-item-id"] || testid,
      reducedMotion,
      renderChildren: (node.children || []).map(c => renderTree(c, renderText, callbacks, React, reducedMotion, toolElementCache)),
      type: node.type,
      props: node.props,
    });
  }

  const isText = testid === "text-block" && props["data-role"] !== "user";
  const text = node.children?.[0]?.children?.[0];
  const children = isText && renderText ? [renderText(String(text ?? ""), { streaming: props["data-streaming"] === "true" })]
    : (node.children || []).map(child => renderTree(child, renderText, callbacks, React, reducedMotion, toolElementCache));
  const element = createElement(node.type, { key: props["data-item-id"] ?? props["data-call-id"], ...props }, ...children);
  if (testid === "tool-block") toolElementCache?.set(node, element);
  return element;
}

// ── scroll mask helpers (reasoning.tsx / scrollMask.ts semantics) ───────────
// The pure mask-state resolvers and style builders live at module scope (see
// exports above) so they are testable without React. The behavior components
// below consume them directly.

/**
 * A scroll viewport that auto-follows its trailing edge while content grows,
 * and yields to the reader when they scroll away. While `streaming` is true and
 * the user is at the bottom, each content change re-pins to the bottom; once
 * the user scrolls up, following stops until they scroll back to the bottom.
 * When `mask` is "vertical" it also reports the top/bottom fade mask state via
 * `data-reasoning-scroll-mask` and a mask style. Honors prefers-reduced-motion
 * (direct scrollTop, never smooth; the mask is a static gradient).
 */
function CommandBox({ renderChildren, type, props }) {
  const ref = useRef(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node || expanded) return;
    const measure = () => setOverflowing(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [renderChildren, expanded]);
  return React.createElement(type, props,
    React.createElement("div", { ref, className: "harness-command-viewport", "data-expanded": String(expanded), tabIndex: expanded ? 0 : undefined }, renderChildren[0]),
    overflowing || expanded ? React.createElement("button", {
      type: "button", className: "harness-command-toggle", "aria-expanded": expanded,
      onClick: () => { if (ref.current) ref.current.scrollTop = 0; setExpanded(value => !value); },
    }, props[expanded ? "data-collapse-label" : "data-expand-label"]) : null,
    ...renderChildren.slice(1));
}

function FollowBox({ streaming, axis, mask, freezeWhileReading = false, reducedMotion, renderChildren, type, props }) {
  const ref = useRef(null);
  const following = useRef(true);
  const prevTop = useRef(0);
  const hasStreamed = useRef(streaming);
  const [frozen, setFrozen] = useState(null);
  const [maskState, setMaskState] = useState({ showTop: false, showBottom: false });
  const isFollowing = freezeWhileReading ? frozen === null : following.current;
  const display = frozen ?? renderChildren;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    if (streaming) hasStreamed.current = true;
    if ((freezeWhileReading ? hasStreamed.current : streaming) && isFollowing) {
      if (axis === "vertical") node.scrollTop = node.scrollHeight;
      else node.scrollLeft = node.scrollWidth;
      prevTop.current = node.scrollTop;
    }
    if (mask === "vertical") {
      setMaskState(previous => resolveVerticalMaskState({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }, previous));
    }
  });

  useEffect(() => {
    const node = ref.current;
    if (!node || mask !== "vertical" || typeof ResizeObserver === "undefined") return;
    const sync = () => {
      setMaskState(previous => resolveVerticalMaskState({ clientHeight: node.clientHeight, scrollHeight: node.scrollHeight, scrollTop: node.scrollTop }, previous));
    };
    sync();
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  }, [mask]);

  const onScroll = (event) => {
    const el = event.currentTarget;
    const atEnd = axis === "vertical"
      ? el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_THRESHOLD_PX
      : el.scrollWidth - el.scrollLeft - el.clientWidth <= FOLLOW_THRESHOLD_PX;
    if (freezeWhileReading && hasStreamed.current && isFollowing && el.scrollTop < prevTop.current && !atEnd) {
      setFrozen(display);
    } else if (freezeWhileReading && !isFollowing && atEnd) {
      setFrozen(null);
    } else if (!freezeWhileReading && following.current && el.scrollTop < prevTop.current && !atEnd) {
      following.current = false;
    } else if (!freezeWhileReading && !following.current && atEnd) {
      following.current = true;
    }
    prevTop.current = el.scrollTop;
    if (mask === "vertical") {
      setMaskState(previous => resolveVerticalMaskState({ clientHeight: el.clientHeight, scrollHeight: el.scrollHeight, scrollTop: el.scrollTop }, previous));
    }
  };

  // Reset following when a stream (re)starts so a fresh block pins again.
  useEffect(() => { if (streaming) following.current = true; }, [streaming]);

  const scrollProps = { ref, onScroll, "data-following": isFollowing ? "true" : "false" };
  if (mask === "vertical") {
    const maskData = maskState.showTop && maskState.showBottom ? "both"
      : maskState.showTop ? "top"
      : maskState.showBottom ? "bottom" : "none";
    scrollProps["data-reasoning-scroll-mask"] = maskData;
    const ms = verticalMaskStyle(maskState);
    if (ms) scrollProps.style = { ...(props.style || {}), ...ms };
  }
  return React.createElement(type, { ...props, ...scrollProps }, ...display);
}

/** A horizontal viewport that keeps its trailing edge visible as text grows,
 *  and reports a horizontal fade mask when the line overflows its track. */
function ScrollEnd({ reducedMotion, renderChildren, type, props }) {
  const initial = { key: props['data-line-key'], text: props['data-line-text'] };
  const [frame, setFrame] = useState(() => ({ current: initial, previous: null, animate: false }));
  const playback = useRef(null);
  useEffect(() => {
    playback.current = createSummaryPlayback(initial, next => setFrame(previous => next.refresh
      ? { ...previous, current: next.current } : next));
    return () => { playback.current.dispose(); playback.current = null; };
  }, []);
  useEffect(() => { playback.current?.update(initial, !reducedMotion); }, [initial.key, initial.text, reducedMotion]);
  const ref = useRef(null);
  const [overflowing, setOverflowing] = useState(false);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.scrollLeft = node.scrollWidth;
    const next = node.scrollWidth > node.clientWidth + 1;
    setOverflowing(prev => (prev === next ? prev : next));
    if (typeof ResizeObserver === "undefined") return;
    const sync = () => {
      node.scrollLeft = node.scrollWidth;
      setOverflowing(node.scrollWidth > node.clientWidth + 1);
    };
    const observer = new ResizeObserver(sync);
    observer.observe(node);
    return () => observer.disconnect();
  });
  const maskData = overflowing ? "both" : "none";
  const ms = horizontalMaskStyle(overflowing);
  const scrollProps = { ref, "data-reasoning-streaming-mask": maskData };
  if (ms) scrollProps.style = { ...(props.style || {}), ...ms };
  return React.createElement(type, { ...props, ...scrollProps },
    React.createElement('span', { className: 'harness-summary-roll', 'data-animated': String(frame.animate) },
      frame.animate && frame.previous ? React.createElement('span', {
        key: 'out:' + frame.previous.key, className: 'harness-summary-out', 'aria-hidden': true,
      }, frame.previous.text) : null,
      React.createElement('span', { key: frame.current.key, className: frame.animate ? 'harness-summary-in' : '' }, frame.current.text)));

}


  function WebDelivery({ path, seq, resolve, zh }) {
    const [preview, setPreview] = useState(null);
    const [pending, setPending] = useState(false);
    const [failed, setFailed] = useState(false);
    const lifetime = useRef(null);
    useEffect(() => {
      const controller = new AbortController();
      lifetime.current = controller;
      void resolve({ path, seq }, controller.signal).then(delivery => {
        if (!controller.signal.aborted) setPreview(delivery);
      }).catch(() => {});
      return () => controller.abort();
    }, [path, seq, resolve]);
    if (!preview?.href) return null;
    const filename = path.split('/').at(-1);
    const openLabel = zh ? `打开 ${filename}` : `Open ${filename}`;
    const openSidebar = async () => {
      const signal = lifetime.current.signal;
      setFailed(false);
      setPending(true);
      try { await preview.openInSidebar(signal); }
      catch { if (!signal.aborted) setFailed(true); }
      finally { if (!signal.aborted) setPending(false); }
    };
    const newTab = (label, ariaLabel) => createElement('a', { href: preview.href, target: '_blank', rel: 'noopener noreferrer',
      'aria-label': ariaLabel }, label);
    return createElement('div', { className: 'harness-delivery', 'data-testid': 'web-delivery' },
      createElement('span', { className: 'harness-delivery-icon' },
        createElement('svg', { viewBox: '0 0 24 24', width: 20, height: 20, fill: 'none', stroke: 'currentColor',
          strokeWidth: 1.5, 'aria-hidden': true },
        createElement('circle', { cx: 12, cy: 12, r: 9 }), createElement('ellipse', { cx: 12, cy: 12, rx: 4, ry: 9 }),
        createElement('path', { d: 'M3 12h18' }))),
      createElement('span', { className: 'harness-delivery-name' },
        createElement('strong', { title: path }, filename),
        createElement('small', null, zh ? '网站 · HTML' : 'Website · HTML')),
      preview.openInSidebar ? createElement('div', { className: 'harness-delivery-actions' },
        createElement('button', { type: 'button', disabled: pending, onClick: openSidebar, 'aria-label': openLabel },
          pending ? (zh ? '正在打开…' : 'Opening…') : (zh ? '打开' : 'Open')),
        createElement('details', { className: 'harness-delivery-menu' },
          createElement('summary', { 'aria-label': zh ? '更多打开方式' : 'More ways to open' },
            createElement('svg', { width: 14, height: 14, viewBox: '0 0 24 24', 'aria-hidden': true, fill: 'none', stroke: 'currentColor' },
              createElement('path', { d: 'm6 9 6 6 6-6', strokeWidth: 2 }))),
          newTab(zh ? '在新标签页打开' : 'Open in a new tab')),
        failed ? createElement('span', { role: 'status' }, zh ? '无法打开侧栏预览' : 'Could not open the sidebar preview') : null)
        : newTab(zh ? '打开' : 'Open', openLabel));
  }

  function DeliveryEvidence({ seq, load, openFile, zh }) {
    const [evidence, setEvidence] = useState(null);
    useEffect(() => {
      const controller = new AbortController();
      void load(seq, controller.signal).then(value => {
        if (!controller.signal.aborted) setEvidence(value);
      }).catch(() => {});
      return () => controller.abort();
    }, [seq, load]);
    if (!evidence) return null;
    const { files, screenshots, truncated } = evidence;
    const counts = file => Number.isSafeInteger(file.added) && file.added >= 0
      && Number.isSafeInteger(file.removed) && file.removed >= 0;
    const delta = (added, removed) => createElement('span', { className: 'harness-delivery-delta' },
      createElement('span', null, `+${added}`), createElement('span', null, `−${removed}`));
    const total = files.length && !truncated && files.every(counts)
      ? delta(files.reduce((sum, file) => sum + file.added, 0), files.reduce((sum, file) => sum + file.removed, 0)) : null;
    const label = zh ? `${files.length}${truncated ? '+' : ''} 个文件已更改`
      : `${files.length}${truncated ? '+' : ''} ${files.length === 1 ? 'file' : 'files'} changed`;
    return createElement(React.Fragment, null,
      files.length ? createElement('details', { className: 'harness-delivery-changes', 'data-testid': 'delivery-changes' },
        createElement('summary', null, label, total),
        createElement('ul', null, ...files.map(file => createElement('li', { key: file.path },
          file.deleted || !openFile ? createElement('span', null, file.path)
            : createElement('button', { type: 'button', onClick: () => openFile({ path: file.path, kind: 'file' }) }, file.path),
          counts(file) ? delta(file.added, file.removed) : null)))) : null,
      ...screenshots.map(({ path, href }) => createElement('a', { key: path, className: 'harness-delivery-image',
        'data-testid': 'delivery-screenshot', href, target: '_blank', rel: 'noopener noreferrer' },
      createElement('img', { src: href, alt: path.split('/').at(-1), loading: 'lazy' }))));
  }

  function HarnessTurn({ state, reply, onCopy, onBranch, assistantActions, containerProps, deliveries, resolveWebDelivery,
    deliverySeq, loadDeliveryEvidence, locale = 'zh-CN', ...timeline }) {
    const [copyState, setCopyState] = useState(null);
    const answer = state.items.find(item => item.id === state.finalAnswerId);
    const copy = async () => {
      try {
        const text = answer.sourceMessageId ? state.items.filter(item => item.kind === 'text'
          && item.sourceMessageId === answer.sourceMessageId).map(item => item.text).join('\n\n') : answer.text;
        await (onCopy ? onCopy(text) : navigator.clipboard.writeText(text));
        setCopyState('copied');
      } catch { setCopyState('failed'); }
    };
    const zh = locale.startsWith('zh');
    const copyLabel = copyState === 'copied' ? (zh ? '已复制' : 'Copied') : (zh ? '复制回复' : 'Copy reply');
    const branchLabel = zh ? '从这里新建分支' : 'Branch from here';
    const button = (label, onClick, path) => createElement('button', { type: 'button', title: label, 'aria-label': label, onClick },
      createElement('svg', { viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none', stroke: 'currentColor',
        strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true }, createElement('path', { d: path })));
    const clock = reply?.time ?? state.taskEndedAt;
    return createElement('article', { ...containerProps, className: 'harness-turn', 'data-testid': 'harness-turn' },
      createElement(HarnessTimeline, { state, onCopy, locale, ...timeline }),
      state.taskState === 'failed' && state.taskError
        ? createElement('p', { className: 'harness-turn-error', role: 'alert' }, state.taskError) : null,
      ...(answer?.kind === 'text' && !answer.streaming && resolveWebDelivery ? (deliveries ?? []).map(delivery =>
        createElement(WebDelivery, { key: JSON.stringify([delivery.seq, delivery.path]), ...delivery, resolve: resolveWebDelivery, zh })) : []),
      answer?.kind === 'text' && !answer.streaming && deliverySeq !== undefined && loadDeliveryEvidence
        ? createElement(DeliveryEvidence, { key: deliverySeq, seq: deliverySeq, load: loadDeliveryEvidence, openFile: timeline.onOpenFile, zh }) : null,
      answer?.kind === 'text' && !answer.streaming ? createElement('div', { className: 'harness-reply-actions',
        role: 'group', 'aria-label': zh ? '回复操作' : 'Reply actions' },
      button(copyLabel, copy, copyState === 'copied' ? 'm5 12 4 4L19 6' : 'M8 8h11v12H8zM5 16H4V4h11v1'),
      assistantActions,
      reply?.branchable && onBranch ? button(branchLabel, () => onBranch(reply.seq), 'M5 19 19 5m-6 0h6v6M5 10v9h9') : null,
      typeof clock === 'number' && Number.isFinite(clock) ? createElement('time', { dateTime: new Date(clock).toISOString() },
        new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', hour12: false }).format(clock)) : null,
      copyState === 'failed' ? createElement('span', { role: 'status' }, zh ? '无法复制' : 'Unable to copy') : null) : null);
  }

  function SubagentPane({ state, loading, error, omittedRows = 0, omittedChars = 0, labels = {}, ...timeline }) {
    return React.createElement('section', { className: 'harness-subagent-pane', 'data-testid': 'subagent-pane', 'aria-readonly': true },
      error ? React.createElement('p', { role: 'alert' }, error) : loading ? React.createElement('p', { role: 'status' }, labels.childSyncing || 'Syncing') : null,
      omittedRows || omittedChars ? React.createElement('p', { className: 'harness-subagent-window-notice' }, labels.childOmitted || 'Earlier rows or long fields are omitted in this observation window.') : null,
      state ? React.createElement(HarnessTimeline, { state, labels, ...timeline }) : null);
  }
  return { HarnessTimeline, HarnessTurn, SubagentPane };
}

export { buildViewModel, styles };
