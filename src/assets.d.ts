// SVG files are bundled as text (see "rules" in wrangler.jsonc).
declare module '*.svg' {
  const content: string;
  export default content;
}

// Browser scripts served as-is (see "rules" in wrangler.jsonc).
declare module '*.client.js' {
  const content: string;
  export default content;
}

// The API description, served as-is at /openapi.yaml.
declare module '*.yaml' {
  const content: string;
  export default content;
}
