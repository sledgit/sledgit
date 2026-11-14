// Light/dark. Dark is the default; a saved choice wins; with none saved, the OS preference decides. THEME_BOOT runs inline
// in <head> before first paint (no flash). Plain module (not "use client") so the server layout gets the string itself.
export const THEME_KEY = "it-theme";
export type Theme = "dark" | "light";

export const THEME_BOOT = `(function(){var d=document.documentElement,t;try{t=localStorage.getItem("${THEME_KEY}")}catch(e){}
if(t!=="light"&&t!=="dark"){t=window.matchMedia&&matchMedia("(prefers-color-scheme: light)").matches?"light":"dark"}d.dataset.theme=t})()`;
