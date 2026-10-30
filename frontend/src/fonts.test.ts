import { describe, expect, it } from 'vitest';
import fontsCss from './fonts.css?raw';
import mainTsx from './main.tsx?raw';
import indexCss from './index.css?raw';

// Police Inter auto-hébergée (#115) : le CSS de l'app doit déclarer « Inter » lui-même, avec
// des fichiers qui existent, au lieu de compter sur une police installée sur le système.

const fontFaces = fontsCss.match(/@font-face\s*\{[^}]*\}/g) ?? [];

describe('police Inter', () => {
  it('est déclarée sous le nom que demande le CSS, en swap, sans CDN', () => {
    expect(indexCss).toMatch(/font-family:\s*"Inter"/);
    expect(fontFaces.length).toBeGreaterThan(0);
    for (const face of fontFaces) {
      expect(face).toMatch(/font-family:\s*"Inter";/);
      expect(face).toMatch(/font-display:\s*swap;/);
      expect(face).toMatch(/font-weight:\s*100 900;/);
      expect(face).toMatch(/unicode-range:/);
      expect(face).not.toMatch(/url\(\s*["']?(https?:)?\/\//);
    }
  });

  it('couvre le sous-ensemble latin, celui du français', () => {
    expect(fontsCss).toContain('inter-latin-wght-normal.woff2');
  });

  it('pointe vers des fichiers woff2 présents dans le paquet', async () => {
    const urls = fontFaces.map((face) => /url\("([^"]+)"\)/.exec(face)?.[1]);
    expect(urls.every((url) => url?.endsWith('.woff2'))).toBe(true);
    for (const url of urls) {
      // L'import échoue si le fichier n'existe pas (paquet absent ou renommé).
      const asset = (await import(/* @vite-ignore */ `${url}?url`)) as { default: string };
      expect(asset.default).toMatch(/\.woff2$/);
    }
  });

  it('est chargée par le point d\'entrée de l\'app', () => {
    expect(mainTsx).toContain("import './fonts.css';");
  });
});
