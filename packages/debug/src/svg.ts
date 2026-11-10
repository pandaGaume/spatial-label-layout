import type { LabelSnapshot, ViewSnapshot } from "@spacexr/spatial-label-layout-core";

export interface SvgOptions {
  /** Draw hidden labels as dashed outlines (default true). */
  showHidden?: boolean;
  /** Label text: defaults to the label id. */
  text?: (label: LabelSnapshot) => string;
  background?: string;
  title?: string;
}

const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

/**
 * 2D debug rendering of one view (brief M1: "debug 2D"). Produces a standalone
 * SVG string: no DOM, no renderer, usable from Node, tests or a dev panel.
 * Colors: green = OK, red = colliding, orange = occluded, grey dashed = hidden.
 */
export const renderViewSvg = (view: ViewSnapshot, options: SvgOptions = {}): string => {
  const { width, height } = view.viewport;
  const showHidden = options.showHidden ?? true;
  const text = options.text ?? ((l: LabelSnapshot) => l.id);
  const parts: string[] = [];
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${f(width)} ${f(height)}" width="${f(width)}" height="${f(height)}" font-family="monospace" font-size="10">`,
  );
  parts.push(`<rect x="0" y="0" width="${f(width)}" height="${f(height)}" fill="${options.background ?? "#0f1419"}"/>`);
  if (options.title) parts.push(`<text x="8" y="16" fill="#9aa5b1" font-size="12">${esc(options.title)}</text>`);

  const crossing = new Set(view.crossingPairs.flat());
  for (const l of view.labels) {
    if (!l.leader || (!l.visible && !showHidden)) continue;
    const pts = l.leader.map((p) => `${f(p.x)},${f(p.y)}`).join(" ");
    const stroke = !l.visible ? "#4b5563" : crossing.has(l.id) ? "#eab308" : "#94a3b8";
    parts.push(`<polyline points="${pts}" fill="none" stroke="${stroke}" stroke-width="1"${l.visible ? "" : ' stroke-dasharray="3 3"'}/>`);
  }
  for (const l of view.labels) {
    if (!l.corners || (!l.visible && !showHidden)) continue;
    const pts = l.corners.map((p) => `${f(p.x)},${f(p.y)}`).join(" ");
    const color = !l.visible ? "#4b5563" : l.colliding ? "#ef4444" : l.occluded ? "#f97316" : "#22c55e";
    const fill = l.visible ? `${color}33` : "none";
    parts.push(
      `<polygon points="${pts}" fill="${fill}" stroke="${color}" stroke-width="1"${l.visible ? "" : ' stroke-dasharray="3 3"'}><title>${esc(
        `${l.id} (anchor ${l.anchorId}, priority ${l.priority})${l.hiddenReason ? ` hidden: ${l.hiddenReason}` : ""}`,
      )}</title></polygon>`,
    );
    if (l.center && l.visible) {
      parts.push(`<text x="${f(l.center.x)}" y="${f(l.center.y + 3)}" fill="#e5e7eb" text-anchor="middle">${esc(text(l))}</text>`);
    }
  }
  for (const l of view.labels) {
    if (!l.anchor) continue;
    parts.push(`<circle cx="${f(l.anchor.x)}" cy="${f(l.anchor.y)}" r="2.5" fill="${l.visible ? "#38bdf8" : "#4b5563"}"/>`);
  }
  parts.push("</svg>");
  return parts.join("\n");
};
