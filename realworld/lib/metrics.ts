/**
 * Chrome-only measurements over DevTools (CPU, heap, DOM counters). Firefox's WebDriver exposes none of these,
 * so scenarios that need them report `NOT_VERIFIED` for Firefox instead of inventing a number.
 */
import { ChromeTab, type Tab } from './driver';

export interface PageCounters {
  readonly nodes: number;
  readonly listeners: number;
  readonly documents: number;
  /** Post-GC used JS heap, bytes. */
  readonly heapBytes: number;
  /** Cumulative main-thread task time of the page, seconds. */
  readonly taskSeconds: number;
  readonly scriptSeconds: number;
  readonly layoutSeconds: number;
}

export function isChrome(tab: Tab): tab is ChromeTab {
  return tab instanceof ChromeTab;
}

export async function counters(tab: ChromeTab, gc = true): Promise<PageCounters> {
  const cdp = await tab.session();
  await cdp.send('Performance.enable');
  if (gc) await cdp.send('HeapProfiler.collectGarbage');
  const dom = await cdp.send('Memory.getDOMCounters');
  const heap = (await cdp.send('Runtime.getHeapUsage')) as { usedSize: number };
  const raw = await cdp.send('Performance.getMetrics');
  const m = Object.fromEntries(raw.metrics.map((x) => [x.name, x.value]));
  return {
    nodes: dom.nodes,
    listeners: dom.jsEventListeners,
    documents: dom.documents,
    heapBytes: heap.usedSize,
    taskSeconds: m['TaskDuration'] ?? 0,
    scriptSeconds: m['ScriptDuration'] ?? 0,
    layoutSeconds: m['LayoutDuration'] ?? 0,
  };
}

/** Installs a long-task and frame-gap recorder in the page (call before the work; read with `readFrames`). */
export const FRAME_RECORDER = `(() => {
  const w = window;
  if (w.__rwFrames) { w.__rwFrames.reset(); return true; }
  const state = { maxGap: 0, longTasks: [], last: performance.now(), running: true };
  const tick = (t) => { state.maxGap = Math.max(state.maxGap, t - state.last); state.last = t; if (state.running) requestAnimationFrame(tick); };
  requestAnimationFrame((t) => { state.last = t; requestAnimationFrame(tick); });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) state.longTasks.push(e.duration); }).observe({ entryTypes: ['longtask'] }); } catch (e) { state.noLongTasks = true; }
  w.__rwFrames = { state, reset() { state.maxGap = 0; state.longTasks = []; state.last = performance.now(); }, stop() { state.running = false; } };
  return true;
})()`;

export interface FrameReading {
  readonly maxGap: number;
  readonly longTasks: number[];
  readonly noLongTasks: boolean;
}

export const READ_FRAMES = `(() => { const s = window.__rwFrames.state; return { maxGap: s.maxGap, longTasks: s.longTasks.slice(), noLongTasks: !!s.noLongTasks }; })()`;
