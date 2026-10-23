"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";

/**
 * Global route-transition indicator (QA UI-05): a thin bar at the top of the viewport that
 * appears as soon as an in-app navigation starts (link click or back/forward) and completes when
 * the new route has rendered. One instance lives in the root layout, so Admin and both portals
 * share it; page-level skeletons remain optional extras.
 *
 * - Starts only for same-origin, non-modified, non-download link clicks that change the URL.
 * - Delayed by 120 ms so instant (cached) navigations never flash a bar.
 * - Completes on pathname/search change; a safety timeout clears it if a navigation is aborted.
 */
const SHOW_DELAY_MS = 120;
const SAFETY_TIMEOUT_MS = 15_000;

type Phase = "idle" | "loading" | "done";

export function NavigationProgress() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [phase, setPhase] = useState<Phase>("idle");
  const [visible, setVisible] = useState(false);
  const pendingRef = useRef(false);
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const routeKey = `${pathname}?${searchParams.toString()}`;
  const routeKeyRef = useRef(routeKey);

  useEffect(() => {
    // Route changed → finish any pending navigation.
    if (routeKeyRef.current === routeKey) return;
    routeKeyRef.current = routeKey;
    if (!pendingRef.current) return;
    pendingRef.current = false;
    if (showTimer.current) clearTimeout(showTimer.current);
    if (safetyTimer.current) clearTimeout(safetyTimer.current);
    setPhase("done");
    const t = setTimeout(() => {
      setPhase("idle");
      setVisible(false);
    }, 260);
    return () => clearTimeout(t);
  }, [routeKey]);

  useEffect(() => {
    function start() {
      if (pendingRef.current) return;
      pendingRef.current = true;
      showTimer.current = setTimeout(() => {
        if (!pendingRef.current) return;
        setVisible(true);
        setPhase("loading");
      }, SHOW_DELAY_MS);
      safetyTimer.current = setTimeout(() => {
        pendingRef.current = false;
        setPhase("idle");
        setVisible(false);
      }, SAFETY_TIMEOUT_MS);
    }
    function onClick(e: MouseEvent) {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const anchor = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!anchor || anchor.target === "_blank" || anchor.hasAttribute("download")) return;
      const url = new URL(anchor.href, window.location.href);
      if (url.origin !== window.location.origin) return;
      if (url.pathname.startsWith("/api/")) return; // downloads / endpoints, not routes
      const current = window.location.pathname + window.location.search;
      if (url.pathname + url.search === current) return; // same page (hash or no-op)
      start();
    }
    function onPopState() {
      start();
    }
    document.addEventListener("click", onClick, true);
    window.addEventListener("popstate", onPopState);
    return () => {
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("popstate", onPopState);
      if (showTimer.current) clearTimeout(showTimer.current);
      if (safetyTimer.current) clearTimeout(safetyTimer.current);
    };
  }, []);

  return (
    <div data-slot="navigation-progress" data-phase={phase} aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-[100] h-0.5">
      <div
        className="h-full bg-primary"
        style={{
          width: phase === "loading" ? "85%" : phase === "done" ? "100%" : "0%",
          opacity: visible ? 1 : 0,
          transition: phase === "loading" ? "width 6s cubic-bezier(0.1, 0.7, 0.2, 1), opacity 120ms" : phase === "done" ? "width 150ms ease-out, opacity 200ms 100ms" : "none",
        }}
      />
    </div>
  );
}
