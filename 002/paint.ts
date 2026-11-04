import { CanvasTexture, SRGBColorSpace } from "three";
import { art } from "./art";

export function paint(w: number, h: number) {
  const tex = new CanvasTexture(art(w, h));
  tex.colorSpace = SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
