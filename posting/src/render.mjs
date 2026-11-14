// SVG → PNG with resvg (system fonts). The SVG is the deterministic artefact; the PNG is for posting.
import { Resvg } from "@resvg/resvg-js";

export function toPng(svg) {
  return new Resvg(svg, { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: true, defaultFontFamily: "Helvetica" } }).render().asPng();
}
