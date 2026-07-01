import React, { useLayoutEffect, useRef } from 'react';
import { Highlight } from 'prism-react-renderer';
import { codeTheme } from '../MainPanel/ForumView/codeTheme';
import '../MainPanel/ForumView/prismLanguages'; // effet de bord : enregistre les grammaires Prism
import styles from './CodeEditor.module.css';

/** Noms de langage dont la grammaire Prism diffère du nom affiché (minuscule). */
const PRISM_ALIASES: Record<string, string> = {
  'c++': 'cpp',
  'c#': 'csharp',
  html: 'markup',
};

/** Paires auto-fermées : ouvreur → fermeur (les guillemets sont leur propre paire). */
const OPEN_PAIRS: Record<string, string> = {
  '(': ')',
  '[': ']',
  '{': '}',
  '"': '"',
  "'": "'",
  '`': '`',
};
/** Caractères « franchissables » : retapés devant eux-mêmes, on saute par-dessus. */
const CLOSE_OVER = new Set([')', ']', '}', '"', "'", '`']);

interface CodeEditorProps {
  /** Code courant. */
  value: string;
  /** Notifie chaque changement. */
  onChange: (value: string) => void;
  /** Langage (nom, ex. « Python ») pour la coloration syntaxique. */
  language?: string;
  placeholder?: string;
  ariaLabel?: string;
  /** Hauteur minimale, en lignes (défaut 4). */
  minRows?: number;
  /** Lecture seule : pas d'édition (utilisé pour la révision d'une réponse). */
  readOnly?: boolean;
}

/**
 * Éditeur de code « façon IDE » : gouttière de numéros + zone de saisie monospace
 * avec **coloration syntaxique** (mêmes couleurs Prism que le rendu Markdown). La
 * coloration est un `<pre>` rendu SOUS un `<textarea>` au texte transparent (seul
 * le caret reste visible) ; les deux partagent métriques et padding et défilent
 * ensemble. La hauteur s'ajuste au contenu (comme le `MarkdownEditor`).
 */
export function CodeEditor({
  value,
  onChange,
  language,
  placeholder,
  ariaLabel,
  minRows = 4,
  readOnly = false,
}: CodeEditorProps): React.ReactElement {
  const taRef = useRef<HTMLTextAreaElement>(null);
  const highlightRef = useRef<HTMLPreElement>(null);
  // Barre de défilement horizontale « proxy » : pleine largeur de l'éditeur (sous la
  // gouttière comprise), synchronisée avec le textarea (dont la scrollbar native est
  // masquée). Le textarea reste le vrai défileur → le suivi du curseur est conservé.
  const hscrollRef = useRef<HTMLDivElement>(null);
  const hscrollInnerRef = useRef<HTMLDivElement>(null);

  /** Met à jour la largeur/visibilité de la barre proxy selon le débordement du code. */
  function updateHScroll() {
    const ta = taRef.current;
    const hs = hscrollRef.current;
    const inner = hscrollInnerRef.current;
    if (!ta || !hs || !inner) return;
    const maxScroll = ta.scrollWidth - ta.clientWidth;
    if (maxScroll > 1) {
      hs.style.display = 'block';
      // Largeur interne = largeur visible (pleine) + course de défilement du code,
      // pour que la course ET la proportion du curseur de la barre correspondent.
      inner.style.width = `${hs.clientWidth + maxScroll}px`;
      if (hs.scrollLeft !== ta.scrollLeft) hs.scrollLeft = ta.scrollLeft;
    } else {
      hs.style.display = 'none';
    }
  }

  // Ancêtre défilant le plus proche (le textarea grandit avec le contenu : il ne
  // défile PAS verticalement, c'est un conteneur au-dessus qui le fait). null → fenêtre.
  function getScrollParent(el: HTMLElement): HTMLElement | null {
    let node = el.parentElement;
    while (node) {
      const oy = getComputedStyle(node).overflowY;
      if ((oy === 'auto' || oy === 'scroll') && node.scrollHeight > node.clientHeight) return node;
      node = node.parentElement;
    }
    return null;
  }

  // Suivi VERTICAL du curseur : le défilement natif d'un textarea ne s'applique pas ici
  // (hauteur = contenu, jamais de scroll interne), donc on fait défiler l'ancêtre pour
  // garder la ligne du curseur visible. (L'horizontal, lui, défile dans le textarea.)
  function scrollCaretIntoView() {
    const ta = taRef.current;
    if (!ta) return;
    const cs = getComputedStyle(ta);
    const lineHeight = parseFloat(cs.lineHeight) || 0;
    if (!lineHeight) return;
    const padTop = parseFloat(cs.paddingTop) || 0;
    // Position du curseur ACTIF : extrémité mobile de la sélection (vers le haut →
    // début, sinon fin). La valeur du DOM est la source de vérité au moment de l'appel.
    const pos = ta.selectionDirection === 'backward' ? ta.selectionStart : ta.selectionEnd;
    const lineIndex = ta.value.slice(0, pos).split('\n').length - 1;
    const taRect = ta.getBoundingClientRect();
    const caretTop = taRect.top + padTop + lineIndex * lineHeight;
    const caretBottom = caretTop + lineHeight;
    // Marge : on garde une ligne et demie de contexte au-dessus/dessous du curseur.
    const margin = lineHeight * 1.5;
    const container = getScrollParent(ta);
    if (container) {
      const r = container.getBoundingClientRect();
      if (caretBottom > r.bottom - margin) container.scrollTop += caretBottom - (r.bottom - margin);
      else if (caretTop < r.top + margin) container.scrollTop -= r.top + margin - caretTop;
    } else {
      if (caretBottom > window.innerHeight - margin) {
        window.scrollBy(0, caretBottom - (window.innerHeight - margin));
      } else if (caretTop < margin) {
        window.scrollBy(0, caretTop - margin);
      }
    }
  }

  // Nom de langage → grammaire Prism (certains noms diffèrent : C++ = `cpp`).
  const raw = (language ?? 'text').toLowerCase();
  const prismLang = PRISM_ALIASES[raw] ?? raw;

  // Auto-dimensionnement vertical (calqué sur MarkdownEditor) : la hauteur suit le
  // contenu. Re-mesure à chaque frappe, au changement de LARGEUR (popup animé,
  // rotation) et quand les polices finissent de charger (métriques différentes).
  useLayoutEffect(() => {
    const ta = taRef.current;
    if (!ta) return;
    const resize = () => {
      ta.style.height = 'auto';
      const base = ta.scrollHeight; // contenu + padding (box-sizing: border-box)
      ta.style.height = `${base}px`;
      // `scrollHeight` n'inclut ni la bordure ni une éventuelle scrollbar
      // horizontale (lignes longues, white-space: pre) : on les rattrape pour ne
      // pas rogner la dernière ligne.
      const chrome = ta.offsetHeight - ta.clientHeight;
      const cs = getComputedStyle(ta);
      const lineHeight = parseFloat(cs.lineHeight) || 0;
      const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);
      const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      const minHeight = minRows * lineHeight + padY + borderY;
      ta.style.height = `${Math.max(base + chrome, minHeight)}px`;
      updateHScroll();
    };
    resize();

    // Re-mesure sur changement de largeur seulement (on ignore les variations de
    // hauteur provoquées par `resize` lui-même, pour ne pas boucler).
    let lastWidth = ta.clientWidth;
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth !== lastWidth) {
        lastWidth = ta.clientWidth;
        resize();
      }
    });
    ro.observe(ta);

    let cancelled = false;
    document.fonts?.ready?.then(() => {
      if (!cancelled) resize();
    });

    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [value, minRows]);

  // Numéros de ligne : UNIQUEMENT les lignes réelles (≥ 1). La hauteur minimale du
  // champ vient du `min-height` (cf. resize/minRows), pas de numéros fantômes — donc
  // pas de n° de ligne en face des lignes vides sous le contenu.
  const lineCount = Math.max(value.split('\n').length, 1);
  const gutter = Array.from({ length: lineCount }, (_, i) => i + 1).join('\n');

  // Défilement piloté par le textarea (molette, clavier, suivi du curseur) : on
  // répercute sur la couche colorée ET sur la barre proxy.
  function onTextareaScroll() {
    const ta = taRef.current;
    const hl = highlightRef.current;
    const hs = hscrollRef.current;
    if (!ta) return;
    if (hl) {
      hl.scrollLeft = ta.scrollLeft;
      hl.scrollTop = ta.scrollTop;
    }
    if (hs && hs.scrollLeft !== ta.scrollLeft) hs.scrollLeft = ta.scrollLeft;
  }

  // Défilement piloté par la barre proxy (l'utilisateur la fait glisser) : on
  // répercute sur le textarea (le vrai défileur) et la couche colorée.
  function onProxyScroll() {
    const ta = taRef.current;
    const hl = highlightRef.current;
    const hs = hscrollRef.current;
    if (!ta || !hs) return;
    const sl = hs.scrollLeft;
    if (ta.scrollLeft !== sl) ta.scrollLeft = sl;
    if (hl && hl.scrollLeft !== sl) hl.scrollLeft = sl;
  }

  /** Remplace la sélection par `insert` et place le curseur à `caret`. */
  function applyEdit(ta: HTMLTextAreaElement, start: number, end: number, insert: string, caret: number) {
    onChange(value.slice(0, start) + insert + value.slice(end));
    requestAnimationFrame(() => {
      ta.focus();
      ta.setSelectionRange(caret, caret);
      scrollCaretIntoView();
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    const ta = e.currentTarget;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;

    // Tab = indentation (4 espaces) plutôt que changement de champ.
    if (e.key === 'Tab' && !e.shiftKey) {
      e.preventDefault();
      const indent = '    ';
      applyEdit(ta, start, end, indent, start + indent.length);
      return;
    }

    // Backspace dans l'indentation (que des espaces avant le curseur sur la ligne) :
    // on retire un niveau entier — jusqu'au taquet précédent (multiple de 4).
    if (e.key === 'Backspace' && start === end && !e.nativeEvent.isComposing) {
      // Paire vide autour du curseur ({|}, (|), "|") : on supprime les deux côtés.
      const prev = value[start - 1];
      if (prev && OPEN_PAIRS[prev] === value[start]) {
        e.preventDefault();
        applyEdit(ta, start - 1, start + 1, '', start - 1);
        return;
      }
      const before = value.slice(0, start);
      const lineBefore = before.slice(before.lastIndexOf('\n') + 1);
      if (lineBefore.length > 0 && /^ +$/.test(lineBefore)) {
        e.preventDefault();
        const unit = 4;
        const remove = lineBefore.length % unit || unit;
        applyEdit(ta, start - remove, end, '', start - remove);
        return;
      }
    }

    // Entrée = nouvelle ligne en CONSERVANT l'indentation courante ; +1 niveau après
    // un ouvreur de bloc (`:` Python, `{`/`[`/`(`) ; et si le curseur est entre une
    // paire (`{|}`), on développe le bloc sur trois lignes (curseur indenté au milieu).
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      const before = value.slice(0, start);
      const after = value.slice(end);
      const currentLine = before.slice(before.lastIndexOf('\n') + 1);
      const indent = (currentLine.match(/^[ \t]*/) ?? [''])[0];
      const unit = '    ';
      const opensBlock = /[:{[(]$/.test(currentLine.replace(/\s+$/, ''));
      const closers: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
      const opener = before.slice(-1);

      if (closers[opener] && after.startsWith(closers[opener])) {
        const insert = `\n${indent}${unit}\n${indent}`;
        applyEdit(ta, start, end, insert, start + 1 + indent.length + unit.length);
      } else {
        const newIndent = indent + (opensBlock ? unit : '');
        applyEdit(ta, start, end, `\n${newIndent}`, start + 1 + newIndent.length);
      }
      return;
    }

    // Type-over : retaper un fermeur déjà juste après le curseur le franchit (évite
    // le doublon que créerait l'auto-fermeture, ex. `()` puis on tape `)`).
    if (
      CLOSE_OVER.has(e.key) &&
      start === end &&
      value[start] === e.key &&
      !e.metaKey &&
      !e.nativeEvent.isComposing
    ) {
      e.preventDefault();
      requestAnimationFrame(() => {
        ta.focus();
        ta.setSelectionRange(start + 1, start + 1);
        scrollCaretIntoView();
      });
      return;
    }

    // Auto-fermeture : taper un ouvreur insère aussi le fermeur (et entoure la
    // sélection si présente). On n'auto-ferme PAS en plein mot (ex. guillemet après
    // une lettre) ni juste avant un caractère « collé », pour ne pas gêner la frappe.
    if (OPEN_PAIRS[e.key] && !e.metaKey && !e.nativeEvent.isComposing) {
      const open = e.key;
      const close = OPEN_PAIRS[open];
      const selected = value.slice(start, end);
      if (selected) {
        e.preventDefault();
        onChange(value.slice(0, start) + open + selected + close + value.slice(end));
        requestAnimationFrame(() => {
          ta.focus();
          ta.setSelectionRange(start + 1, end + 1); // sélection conservée à l'intérieur
          scrollCaretIntoView();
        });
        return;
      }
      const nextChar = value[start] ?? '';
      const prevChar = value[start - 1] ?? '';
      const isQuote = open === close;
      const closeAllowed =
        (nextChar === '' || /[\s)\]}>.,;:]/.test(nextChar)) && !(isQuote && /\w/.test(prevChar));
      if (closeAllowed) {
        e.preventDefault();
        applyEdit(ta, start, end, open + close, start + 1);
        return;
      }
    }
  }

  return (
    <div className={styles.editor}>
      <div className={styles.body}>
        <div className={styles.gutter} aria-hidden>
          {gutter}
        </div>
        <div className={styles.codeWrap}>
          {/* Couche colorée (sous le textarea). `code` reçoit un espace si vide pour
              garder une ligne et éviter un saut de hauteur. */}
          <Highlight code={value || ' '} language={prismLang} theme={codeTheme}>
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre className={styles.highlight} aria-hidden ref={highlightRef}>
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
          <textarea
            ref={taRef}
            className={styles.textarea}
            value={value}
            readOnly={readOnly}
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            wrap="off"
            rows={minRows}
            placeholder={placeholder}
            aria-label={ariaLabel}
            onChange={(e) => onChange(e.target.value)}
            onScroll={onTextareaScroll}
            // Suivi vertical du curseur : la frappe normale et la navigation (flèches)
            // remontent ici après mise à jour du caret ; le clic repositionne aussi.
            onKeyUp={scrollCaretIntoView}
            onClick={scrollCaretIntoView}
            // En lecture seule : pas de logique d'édition (Tab/Entrée/auto-fermeture…),
            // sinon nos handlers modifieraient quand même la valeur (readOnly ne bloque
            // que la saisie clavier native, pas les changements programmatiques).
            onKeyDown={readOnly ? undefined : onKeyDown}
          />
        </div>
      </div>
      {/* Barre de défilement horizontale pleine largeur (proxy synchronisé). */}
      <div className={styles.hscroll} ref={hscrollRef} aria-hidden onScroll={onProxyScroll}>
        <div className={styles.hscrollInner} ref={hscrollInnerRef} />
      </div>
    </div>
  );
}
