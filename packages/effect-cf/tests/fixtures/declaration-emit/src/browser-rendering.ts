import { BrowserRendering } from "effect-cf";

export class Browser extends BrowserRendering.Tag<Browser>()("Browser") {}

export const bindingLayer = Browser.layer({ binding: "BROWSER" });
