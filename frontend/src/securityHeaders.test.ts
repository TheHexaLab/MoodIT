// @vitest-environment node
import { describe, expect, it } from 'vitest';
import indexHtml from '../index.html?raw';
import headersConf from '../nginx/security-headers.conf?raw';
import caddyfile from '../../deploy/Caddyfile?raw';

// Cohérence des en-têtes de sécurité (#93) avec le code servi. Les en-têtes réellement envoyés par
// l'image nginx sont vérifiés par le test e2e e2e/core/security-headers.spec.ts.

/** Valeur d'un `add_header <nom> "<valeur>" always;` de security-headers.conf. */
function nginxHeader(name: string): string | undefined {
  const match = headersConf.match(new RegExp(`^add_header ${name} "([^"]*)" always;$`, 'm'));
  return match?.[1];
}

/** Valeur d'un en-tête `<nom> "<valeur>"` du bloc security_headers de deploy/Caddyfile. */
function caddyHeader(name: string): string | undefined {
  const match = caddyfile.match(new RegExp(`^\\s*${name} "([^"]*)"$`, 'm'));
  return match?.[1];
}

/** Sources d'une directive CSP (`undefined` si la directive est absente). */
function directive(policy: string, name: string): string[] | undefined {
  const entry = policy
    .split(';')
    .map((part) => part.trim().split(/\s+/))
    .find(([directiveName]) => directiveName === name);
  return entry?.slice(1);
}

/** Empreinte CSP (`'sha256-…'`) d'un script inline, calculée sur son contenu exact. */
async function scriptHash(content: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(content));
  return `'sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}'`;
}

// Scripts inline de index.html : toute balise <script> sans `src`, quelles que soient la casse et
// les autres attributs (un script externe n'a pas besoin d'empreinte : il relève de 'self').
const inlineScripts = [...indexHtml.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\b[^>]*>/gi)]
  .filter(([, attributes]) => !/\bsrc\s*=/i.test(attributes))
  .map(([, , content]) => content);
const policy = nginxHeader('Content-Security-Policy') ?? '';

describe('en-têtes de sécurité', () => {
  it('chaque script inline de index.html est autorisé par son empreinte', async () => {
    expect(inlineScripts.length).toBeGreaterThan(0);
    for (const script of inlineScripts) {
      expect(directive(policy, 'script-src')).toContain(await scriptHash(script));
    }
  });

  it('la CSP est bloquante, avec nginx pour seule source (ni Report-Only, ni copie dans Caddy)', () => {
    expect(policy).not.toBe('');
    expect(nginxHeader('Content-Security-Policy-Report-Only')).toBeUndefined();
    expect(caddyHeader('Content-Security-Policy')).toBeUndefined();
    expect(caddyfile).not.toMatch(/Content-Security-Policy/);
  });

  it('la CSP interdit le JS inline ou évalué, les objets et la mise en iframe', () => {
    const scriptSrc = directive(policy, 'script-src');
    expect(scriptSrc).toContain("'self'");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
    expect(directive(policy, 'default-src')).toEqual(["'self'"]);
    expect(directive(policy, 'worker-src')).toEqual(["'self'"]);
    expect(directive(policy, 'object-src')).toEqual(["'none'"]);
    expect(directive(policy, 'frame-ancestors')).toEqual(["'none'"]);
    expect(directive(policy, 'connect-src')).toEqual(["'self'"]);
  });

  it('pose les autres en-têtes attendus', () => {
    expect(nginxHeader('X-Frame-Options')).toBe('DENY');
    expect(nginxHeader('X-Content-Type-Options')).toBe('nosniff');
    expect(nginxHeader('Referrer-Policy')).toBe('strict-origin-when-cross-origin');
    const permissions = nginxHeader('Permissions-Policy')?.split(/,\s*/);
    expect(permissions).toContain('camera=(self)');
    expect(permissions).toContain('microphone=(self)');
    expect(permissions).toContain('geolocation=()');
    expect(permissions).toContain('payment=()');
    expect(permissions).toContain('usb=()');
  });

  it('chaque add_header porte `always` (envoyé aussi sur les réponses d’erreur)', () => {
    const lines = headersConf.split('\n').filter((line) => line.startsWith('add_header'));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line).toMatch(/ always;$/);
  });

  it('HSTS est envoyé par Caddy (qui termine TLS), pas par nginx', () => {
    expect(headersConf).not.toMatch(/^add_header Strict-Transport-Security/m);
    expect(caddyHeader('Strict-Transport-Security')).toMatch(/^max-age=\d+/);
  });
});
