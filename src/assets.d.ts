// SVG files are bundled as text (see "rules" in wrangler.jsonc).
declare module '*.svg' {
  const content: string;
  export default content;
}
