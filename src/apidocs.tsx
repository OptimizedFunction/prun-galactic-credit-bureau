// The API reference page: a short how-to, then every endpoint from openapi.yaml rendered with Swagger UI,
// where each one can be tried against this site.
import { Hono } from 'hono';
import spec from '../openapi.yaml';
import { Layout } from './pages';
import type { Env } from './env';

export const apiDocs = new Hono<{ Bindings: Env }>();

/** Pinned release of Swagger UI, loaded from cdnjs. */
const SWAGGER = 'https://cdnjs.cloudflare.com/ajax/libs/swagger-ui/5.17.14';

const DOCS_CSS = `
.quick { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 12px; margin: 0 0 20px; }
.quick .panel h2 { margin: 0 0 6px; font-size: 16px; }
.quick .panel p { margin: 0 0 8px; }
pre.code { margin: 0; padding: 10px 12px; background: var(--chip); border-radius: 6px; font: 13px/1.5 ui-monospace, SFMono-Regular, Consolas, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
/* Swagger UI is designed for a light page, so it sits on its own light sheet in both themes. */
#swagger { padding: 4px 0 12px; color-scheme: light; background: #fff; border: 1px solid var(--line); border-radius: 10px; }
#swagger .swagger-ui .info { margin: 20px 0; }
#swagger .swagger-ui .scheme-container { box-shadow: none; padding: 12px 0; }
`;

const SWAGGER_SCRIPT = `
window.addEventListener('load', function () {
  if (!window.SwaggerUIBundle) {
    document.getElementById('swagger').innerHTML = '<p style="padding:16px;color:#333">The interactive reference could not load. The full description is in <a href="/openapi.yaml">openapi.yaml</a>.</p>';
    return;
  }
  window.SwaggerUIBundle({
    url: '/openapi.yaml',
    dom_id: '#swagger',
    deepLinking: true,
    docExpansion: 'list',
    defaultModelsExpandDepth: 0,
    tryItOutEnabled: true,
    // Open the read-only groups first; the rest need a sign-in or a key.
    tagsSorter: function (a, b) {
      var order = ['Borrowers', 'Lenders', 'Loans', 'Bureau', 'Reporting', 'Editing', 'Tracking', 'Maintainers'];
      return order.indexOf(a) - order.indexOf(b);
    },
  });
});`;

/** The machine-readable description, for tools and for Swagger UI above. */
apiDocs.get('/openapi.yaml', (c) => c.body(spec, 200, { 'Content-Type': 'application/yaml; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'Access-Control-Allow-Origin': '*' }));

apiDocs.get('/api', (c) => {
  const origin = new URL(c.req.url).origin;
  return c.html(
    <Layout title="API" description="How to read the PrUn Galactic Credit Bureau from your own tools: endpoints, examples and limits.">
      <style dangerouslySetInnerHTML={{ __html: DOCS_CSS }} />
      <link rel="stylesheet" href={`${SWAGGER}/swagger-ui.min.css`} />
      <h1>API</h1>
      <p class="sub">
        Everything on this site is available as JSON. Reading needs no key and no account. The base address is <code>{origin}/api/v1</code>.
      </p>

      <div class="quick">
        <div class="panel">
          <h2>Look up a company</h2>
          <p>By in-game username or company code. Returns the whole record, as borrower and as lender.</p>
          <pre class="code">{`curl ${origin}/api/v1/companies/OptimizedFunction\ncurl ${origin}/api/v1/companies/SL?by=code`}</pre>
        </div>
        <div class="panel">
          <h2>Check a borrower</h2>
          <p>What they owe per currency and combined, their breaches, and every loan.</p>
          <pre class="code">{`curl ${origin}/api/v1/borrowers/{username}`}</pre>
        </div>
        <div class="panel">
          <h2>Report your own loans</h2>
          <p>
            Lenders who <a href="/track">connected FIO</a> can create a key there and record loans the game cannot see.
          </p>
          <pre class="code">{`curl -X PUT ${origin}/api/v1/lenders/{you}/loans/{reference} \\\n  -H "Authorization: Bearer pgcb_..." \\\n  -H "Content-Type: application/json" \\\n  -d '{"borrower":"SomePlayer","principal":"2,500,000",\n       "currency":"NCC","issuedOn":"2026-11-10","status":"In Progress"}'`}</pre>
        </div>
        <div class="panel">
          <h2>Good to know</h2>
          <p>
            Amounts are text such as <code>"25000000.00"</code> and always come with a currency. Fields named <code>combined</code> add the four
            currencies together as they are.
          </p>
          <p>
            Limits: bursts of 120 requests, refilling 2 a second. A <code>429</code> answer says how long to wait in <code>Retry-After</code>.
          </p>
          <p>
            Machine-readable description: <a href="/openapi.yaml">openapi.yaml</a>.
          </p>
        </div>
      </div>

      <h2>Every endpoint</h2>
      <p class="hint">Open an endpoint and press Execute to try it against this site. Endpoints marked with a padlock need a sign-in or a lender key.</p>
      <div id="swagger"></div>
      <script src={`${SWAGGER}/swagger-ui-bundle.min.js`} crossorigin="anonymous"></script>
      <script dangerouslySetInnerHTML={{ __html: SWAGGER_SCRIPT }} />
    </Layout>,
  );
});
