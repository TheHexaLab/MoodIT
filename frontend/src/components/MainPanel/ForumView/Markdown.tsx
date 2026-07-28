import React, { useState } from 'react';
import { Highlight } from 'prism-react-renderer';
import katex from 'katex';
import { codeTheme } from './codeTheme';
import { Copy } from '../../../assets/Copy';
import { Check } from '../../../assets/Check';
import './prismLanguages'; // effet de bord : enregistre les grammaires Prism
import './Markdown.css'; // styles globaux (sélecteurs par role/element) — fichier .css
import 'katex/dist/katex.min.css'; // styles + polices des équations KaTeX
// SIMPLE (pas .module.css) : un .module.css importé pour effet de bord est tree-shaké
// au build de prod (map de classes inutilisée), donc ses styles globaux disparaissent.

/** Alias de langages courants vers le nom de grammaire Prism. */
const LANG_ALIASES: Record<string, string> = {
  'c++': 'cpp',
  h: 'c',
  hpp: 'cpp',
  'c#': 'csharp',
  cs: 'csharp',
  js: 'javascript',
  ts: 'typescript',
  py: 'python',
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  golang: 'go',
  rs: 'rust',
  html: 'markup',
  xml: 'markup',
  svg: 'markup',
};

/** Bloc de code colore (Prism). La langue vient de la fence (``` ```python ```). */
function CodeBlock({ code, lang }: { code: string; lang: string }) {
  const raw = (lang || 'text').toLowerCase();
  const language = LANG_ALIASES[raw] ?? raw;
  /** Retour visuel « Copié » apres une copie reussie (revient a l'etat normal). */
  const [copied, setCopied] = useState(false);

  /** Copie le code brut dans le presse-papiers (avec retour visuel ephemere). */
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      // Presse-papiers indisponible (contexte non securise, permission refusee) :
      // on ignore silencieusement, le bouton reste utilisable.
    }
  }

  return (
    <div role="code-block">
      {/* Coin haut-droit : bouton de copie (apparait au survol) + pastille de langage. */}
      <div role="code-toolbar">
        <button
          type="button"
          role="copy"
          onClick={copyCode}
          aria-label={copied ? 'Copié' : 'Copier'}
          data-copied={copied || undefined}
        >
          {copied ? <Check width={13} height={13} /> : <Copy width={13} height={13} />}
        </button>
        {lang ? <span role="code-lang">{lang}</span> : null}
      </div>
      <Highlight code={code} language={language} theme={codeTheme}>
        {({ style, tokens, getLineProps, getTokenProps }) => (
          <pre style={style}>
            {tokens.map((line, lineIndex) => (
              <div key={lineIndex} {...getLineProps({ line })}>
                {line.map((token, tokenIndex) => (
                  <span key={tokenIndex} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </pre>
        )}
      </Highlight>
    </div>
  );
}

/**
 * Rendu d'un sous-ensemble courant de Markdown en elements React.
 *
 * Couvre : titres (#..######), gras, italique, code en ligne, blocs de code ```,
 * listes (à puces / numérotées), citations (>), filets (---), liens et
 * équations LaTeX ($…$ en ligne, $$…$$ en bloc, via KaTeX).
 *
 * On construit uniquement des elements React (jamais de HTML brut via
 * dangerouslySetInnerHTML) : aucune injection possible. Les `href` sont en plus
 * restreints aux schemes surs (pas de `javascript:`).
 *
 * SEULE EXCEPTION : les équations, où le HTML vient de KaTeX (`renderToString`).
 * C'est sûr car KaTeX ÉCHAPPE le texte de l'utilisateur et n'émet que son propre
 * balisage ; `trust: false` (défaut) bloque les commandes dangereuses (\href,
 * \includegraphics…) et `throwOnError: false` rend une erreur LaTeX en rouge au
 * lieu de lever une exception.
 */

/** Rend une expression LaTeX en HTML KaTeX (chaîne). Jamais d'exception. */
function renderTex(tex: string, displayMode: boolean): string {
  try {
    return katex.renderToString(tex, {
      displayMode,
      throwOnError: false,
      output: 'html',
      strict: false,
    });
  } catch {
    return '';
  }
}

/** Équation en ligne `$…$` (rendu KaTeX). */
function InlineMath({ tex }: { tex: string }) {
  return <span role="math-inline" dangerouslySetInnerHTML={{ __html: renderTex(tex, false) }} />;
}

/** Équation en bloc `$$…$$` (rendu KaTeX, mode display centré). */
function MathBlock({ tex }: { tex: string }) {
  return <div role="math-block" dangerouslySetInnerHTML={{ __html: renderTex(tex, true) }} />;
}

/** Schemes d'URL autorises pour les liens. */
const SAFE_HREF = /^(?:https?:\/\/|\/|#|mailto:)/i;

/**
 * Marques inline : **gras**, *italique*, `code`, [texte](url).
 * Sert de modele : `parseInline` recree une regex neuve a chaque appel (le flag
 * `g` est avec etat — partager l'objet entre les appels recursifs corromprait
 * `lastIndex` et provoquerait une boucle infinie).
 */
// Les groupes 6 (dollar échappé `\$`) et 7 (équation `$…$`) sont AJOUTÉS EN FIN
// pour ne pas décaler les indices des marques existantes. L'équation exige un
// non-espace juste après `$` et juste avant `$` (garde anti « montant en $ » :
// « $5 pour 10 » ne matche pas), et tolère les `\$` internes. Le contenu utilise
// `(?:\\.|[^$\\])` (le backslash n'est consommé QUE par `\\.`) : motif non ambigu,
// pas de backtracking exponentiel (ReDoS) sur une entrée type « $\\\\… » sans fin.
const INLINE_PATTERN =
  /\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|\[(.+?)\]\((https?:\/\/[^\s)]+|\/[^\s)]*|#[^\s)]*|mailto:[^\s)]+)\)|\\(\$)|\$(?!\s)((?:\\.|[^$\\])+?)(?<!\s)\$/g;

/** Detecte le debut d'un bloc « special » (sert a couper les paragraphes). */
const SPECIAL = /^(?:```|\$\$|#{1,6}\s|>\s?|\s*[-*]\s+|\s*\d+\.\s+|(?:---|\*\*\*|___)\s*$)/;

/** Parse les marques inline d'un fragment de texte en noeuds React. */
function parseInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // Regex neuve a chaque appel : `lastIndex` propre, sur pour la recursion.
  const re = new RegExp(INLINE_PATTERN.source, 'g');
  let last = 0;
  let i = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const key = `${keyPrefix}.${i++}`;
    if (match[1] !== undefined) {
      nodes.push(<strong key={key}>{parseInline(match[1], key)}</strong>);
    } else if (match[2] !== undefined) {
      nodes.push(<em key={key}>{parseInline(match[2], key)}</em>);
    } else if (match[3] !== undefined) {
      nodes.push(<code key={key}>{match[3]}</code>);
    } else if (match[4] !== undefined) {
      const href = SAFE_HREF.test(match[5]) ? match[5] : '#';
      nodes.push(
        <a key={key} href={href} target="_blank" rel="noopener noreferrer">
          {parseInline(match[4], key)}
        </a>
      );
    } else if (match[6] !== undefined) {
      nodes.push(match[6]); // `\$` → dollar littéral (pas une équation)
    } else if (match[7] !== undefined) {
      nodes.push(<InlineMath key={key} tex={match[7]} />);
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

/** Convertit une source Markdown en blocs React (paragraphes, titres, listes…). */
function renderBlocks(src: string, keyPrefix: string): React.ReactNode[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];
    const key = `${keyPrefix}.${k++}`;

    // Bloc de code ``` … ```  (avec langage optionnel : ```python)
    if (line.trim().startsWith('```')) {
      const lang = line.trim().slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) buf.push(lines[i++]);
      i++; // saute la fence de fermeture
      blocks.push(<CodeBlock key={key} code={buf.join('\n')} lang={lang} />);
      continue;
    }

    // Bloc mathématique  $$ … $$  (LaTeX, une ou plusieurs lignes)
    if (line.trim().startsWith('$$')) {
      const first = line.trim().slice(2);
      const endOnSame = first.indexOf('$$');
      let tex: string;
      if (endOnSame !== -1) {
        // Tout sur une ligne : $$ … $$
        tex = first.slice(0, endOnSame);
        i++;
      } else {
        // Multi-lignes : on agrège jusqu'à la fence fermante $$
        const buf: string[] = first ? [first] : [];
        i++;
        while (i < lines.length && !lines[i].includes('$$')) buf.push(lines[i++]);
        if (i < lines.length) {
          const closing = lines[i];
          buf.push(closing.slice(0, closing.indexOf('$$')));
          i++;
        }
        tex = buf.join('\n');
      }
      blocks.push(<MathBlock key={key} tex={tex.trim()} />);
      continue;
    }

    // Ligne vide
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Titre #..######  (decale en h2..h6 : pas de h1 dans le contenu d'un post)
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length + 1, 6);
      blocks.push(React.createElement(`h${level}`, { key }, parseInline(heading[2], key)));
      i++;
      continue;
    }

    // Filet horizontal
    if (/^(?:---|\*\*\*|___)\s*$/.test(line)) {
      blocks.push(<hr key={key} />);
      i++;
      continue;
    }

    // Citation >
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={key}>{renderBlocks(buf.join('\n'), key)}</blockquote>);
      continue;
    }

    // Liste a puces
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*[-*]\s+/, ''));
      }
      blocks.push(
        <ul key={key}>
          {items.map((item, j) => (
            <li key={j}>{parseInline(item, `${key}.${j}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Liste numerotee
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i++].replace(/^\s*\d+\.\s+/, ''));
      }
      blocks.push(
        <ol key={key}>
          {items.map((item, j) => (
            <li key={j}>{parseInline(item, `${key}.${j}`)}</li>
          ))}
        </ol>
      );
      continue;
    }

    // Paragraphe : on agrege les lignes consecutives jusqu'au prochain bloc special.
    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !SPECIAL.test(lines[i])) {
      buf.push(lines[i++]);
    }
    blocks.push(<p key={key}>{parseInline(buf.join(' '), key)}</p>);
  }

  return blocks;
}

interface MarkdownProps {
  /** Source Markdown a rendre. */
  source: string;
}

/** Conteneur de rendu Markdown (sous-ensemble courant), sans HTML brut. */
export function Markdown({ source }: MarkdownProps): React.ReactElement {
  return <div role="markdown-container">{renderBlocks(source, 'md')}</div>;
}
