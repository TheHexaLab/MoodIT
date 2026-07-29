import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import './MarkdownEditor.css'; // styles GLOBAUX (sélecteurs par role/élément, aucune classe).
// NB : fichier volontairement .css (et non .module.css). Un import side-effect d'un
// CSS Module est tree-shaké au build prod (aucune classe utilisée → import « inutile »),
// ce qui faisait disparaître ces styles en production alors qu'ils tenaient en dev.
import { Spinner } from '../../Spinner/Spinner';
import { Markdown } from './Markdown';
import { defaultMarkdownEditorLabels } from './labels';
import { type MarkdownEditorLabels } from './types';

/**
 * Ancetre defilant verticalement le plus proche d'un element (ou null). Sert a preserver la
 * position de scroll du feed pendant l'auto-resize du textarea (cf. resize()).
 */
function getScrollableParent(el: HTMLElement): HTMLElement | null {
  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY;
    if (
      (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') &&
      node.scrollHeight > node.clientHeight
    ) {
      return node;
    }
  }
  return null;
}

/** Une entree de menu (libelle affiche + texte insere). */
interface MenuItem {
  label: string;
  value: string;
}

/** Prefixes markdown des niveaux de titre (les libelles viennent des labels). */
const HEADING_PREFIXES = ['# ', '## ', '### ', '#### '] as const;

/** Langages du menu « Bloc de code » (valeur = grammaire Prism ; noms techniques fixes). */
const CODE_LANGUAGES: MenuItem[] = [
  { label: 'Bash / Shell', value: 'bash' },
  { label: 'C', value: 'c' },
  { label: 'C++', value: 'cpp' },
  { label: 'C#', value: 'csharp' },
  { label: 'CSS', value: 'css' },
  { label: 'Go', value: 'go' },
  { label: 'HTML / XML', value: 'markup' },
  { label: 'Java', value: 'java' },
  { label: 'JavaScript', value: 'javascript' },
  { label: 'JSON', value: 'json' },
  { label: 'JSX', value: 'jsx' },
  { label: 'PHP', value: 'php' },
  { label: 'Python', value: 'python' },
  { label: 'Ruby', value: 'ruby' },
  { label: 'Rust', value: 'rust' },
  { label: 'SQL', value: 'sql' },
  { label: 'TypeScript', value: 'typescript' },
  { label: 'TSX', value: 'tsx' },
  { label: 'VHDL', value: 'vhdl' },
  { label: 'YAML', value: 'yaml' },
];

interface MarkdownEditorProps {
  /** Contenu courant (Markdown brut). */
  value: string;
  /** Notifie chaque changement du texte. */
  onChange: (value: string) => void;
  /** Validation (bouton + Ctrl/Cmd+Entrée). Optionnel en mode `embedded`. */
  onSubmit?: () => void;
  /** Annulation (bouton + Échap). Optionnel en mode `embedded`. */
  onCancel?: () => void;
  /** Libelle du bouton de validation (« Enregistrer », « Répondre »…). */
  submitLabel?: string;
  /** Placeholder du textarea. */
  placeholder?: string;
  /** Longueur MAX du contenu (aligne le front sur la limite backend). Affiche un compteur. */
  maxLength?: number;
  /** Desactive la validation en plus du contenu vide (ex. titre manquant). */
  disableSubmit?: boolean;
  /** Focus automatique du textarea au montage (defaut : true). */
  autoFocus?: boolean;
  /** Envoi en cours : le bouton de validation affiche un spinner et se desactive. */
  submitting?: boolean;
  /** Surcharge des textes internes ; les champs omis prennent les défauts. */
  labels?: Partial<MarkdownEditorLabels>;
  /**
   * Mode « champ » : intégré dans un formulaire existant (ex. énoncé de question).
   * Pas de barre d'actions (le formulaire hôte a la sienne) et barre d'outils non
   * collante (le conteneur défilant n'est pas le sien).
   */
  embedded?: boolean;
}

/**
 * Editeur Markdown : barre d'outils (gras/italique/code/lien/liste/citation) qui
 * agit sur la selection du textarea, plus un apercu (œil) qui rend le Markdown.
 * Reutilise pour l'edition d'un post et pour la redaction d'une reponse.
 */
export function MarkdownEditor({
  value,
  onChange,
  onSubmit,
  onCancel,
  submitLabel,
  placeholder,
  maxLength,
  disableSubmit = false,
  autoFocus = true,
  submitting = false,
  labels,
  embedded = false,
}: MarkdownEditorProps): React.ReactElement {
  /** Textes affichés : défauts + surcharges éventuelles via la prop `labels`. */
  const t = { ...defaultMarkdownEditorLabels, ...labels };
  /** Niveaux de titre (libellés depuis les labels, préfixes markdown fixes). */
  const headingLevels: MenuItem[] = [
    { label: t.headingTitle, value: HEADING_PREFIXES[0] },
    { label: t.headingSub, value: HEADING_PREFIXES[1] },
    { label: t.headingSubSub, value: HEADING_PREFIXES[2] },
    { label: t.headingSmall, value: HEADING_PREFIXES[3] },
  ];
  /** Langages : « sans langage » (libellé traduisible) + noms techniques fixes. */
  const codeLanguages: MenuItem[] = [{ label: t.noLanguage, value: '' }, ...CODE_LANGUAGES];

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [preview, setPreview] = useState(false);

  // Auto-dimensionne la zone d'edition selon son contenu (pas de resize manuel).
  // Se relance a chaque changement de texte (frappe ET insertions via la barre),
  // MAIS aussi quand la LARGEUR change (popup qui s'anime, clavier mobile, rotation)
  // et quand les POLICES finissent de charger : sinon le texte se reflowe apres la
  // mesure et la derniere ligne se retrouve coupee.
  useLayoutEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    const resize = () => {
      const scrollParent = getScrollableParent(ta);
      const prevScrollTop = scrollParent ? scrollParent.scrollTop : 0;
      ta.style.height = 'auto';
      // scrollHeight n'inclut pas la bordure (box-sizing: border-box) : on l'ajoute,
      // sinon le contenu deborde de quelques pixels et la derniere ligne est rognee.
      const cs = getComputedStyle(ta);
      const borderY = parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
      ta.style.height = `${ta.scrollHeight + borderY}px`;
      if (!scrollParent) return;

      // Le passage par height:auto (repli du textarea pour la mesure) + le scroll natif du caret
      // font sauter/déborder le feed → ce qu'on écrit atterrit hors de la vue. On FIXE nous-mêmes
      // la position finale, avant le paint :
      //   1. on repart de la position d'origine (annule le clamp du repli) → aucune dérive ;
      scrollParent.scrollTop = prevScrollTop;
      //   2. si on écrit dans ce champ et qu'il déborde du feed, on scrolle du STRICT minimum
      //      pour le rendre visible (pas de dépassement).
      if (document.activeElement !== ta) return;
      const pRect = scrollParent.getBoundingClientRect();
      const margin = 8; // petite marge pour ne pas coller au bord
      // Cible : l'ÉDITEUR COMPLET (barre d'outils + zone de saisie + compteur/boutons) s'il TIENT
      // dans le feed → tout reste visible ; sinon (éditeur plus haut que le feed) on se rabat sur
      // la zone de saisie, pour au moins suivre le curseur.
      const editorRoot = ta.closest('[role^="markdown-editor"]') as HTMLElement | null;
      const rootRect = editorRoot?.getBoundingClientRect();
      const target =
        rootRect && rootRect.height <= pRect.height - margin
          ? rootRect
          : ta.getBoundingClientRect();
      if (target.bottom > pRect.bottom) {
        scrollParent.scrollTop += target.bottom - pRect.bottom + margin;
      } else if (target.top < pRect.top) {
        scrollParent.scrollTop -= pRect.top - target.top + margin;
      }
    };
    resize();

    // Re-mesure sur changement de largeur uniquement (on ignore les variations de
    // hauteur que `resize` provoque lui-meme, pour ne pas boucler).
    let lastWidth = ta.clientWidth;
    const ro = new ResizeObserver(() => {
      if (ta.clientWidth !== lastWidth) {
        lastWidth = ta.clientWidth;
        resize();
      }
    });
    ro.observe(ta);

    // Re-mesure une fois les polices chargees (la 1re mesure peut utiliser une
    // police de repli aux metriques differentes).
    let cancelled = false;
    document.fonts?.ready?.then(() => {
      if (!cancelled) resize();
    });

    return () => {
      cancelled = true;
      ro.disconnect();
    };
  }, [value, preview]);

  /** Entoure la selection de `before`…`after` (gras, italique, code, lien). */
  function wrap(before: string, after: string = before) {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const selected = value.slice(start, end);
    const next = value.slice(0, start) + before + selected + after + value.slice(end);
    onChange(next);
    // Restaure la selection (sur le texte entoure) apres la mise a jour du DOM.
    requestAnimationFrame(() => {
      ta.focus();
      const from = start + before.length;
      ta.setSelectionRange(from, from + selected.length);
    });
  }

  /** Prefixe la ligne courante (liste, citation…). */
  function linePrefix(prefix: string) {
    const ta = textareaRef.current;
    if (!ta) return;
    const start = ta.selectionStart;
    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    const next = value.slice(0, lineStart) + prefix + value.slice(lineStart);
    onChange(next);
    requestAnimationFrame(() => {
      ta.focus();
      const pos = start + prefix.length;
      ta.setSelectionRange(pos, pos);
    });
  }

  /** Insere un bloc de code (fence) avec le langage choisi autour de la selection. */
  function insertCodeBlock(lang: string) {
    wrap('```' + lang + '\n', '\n```');
  }

  // Dépassement de limite : le compteur passe EN ROUGE et l'envoi est désactivé tant que
  // c'est trop long (pas de popup — indicateur inline, cohérent avec le composer du chat).
  const overLimit = maxLength != null && value.length > maxLength;
  const submitDisabled = disableSubmit || value.trim() === '' || overLimit;

  return (
    <div
      role={`markdown-editor${preview ? '-preview' : ''}`}
      data-embedded={embedded ? '' : undefined}
      onClick={(event) => event.stopPropagation()}
    >
      {/* Toolbar + zone de saisie : bloc englobant de la toolbar collante, pour
          qu'elle se decolle a la fin du textarea sans recouvrir les actions. */}
      <div role="editor-main">
      <div role="toolbar" aria-label={t.toolbar}>
        <div>
          <ToolMenu
            icon={<strong>H</strong>}
            title={t.heading}
            ariaLabel={t.headingMenu}
            disabled={preview}
            items={headingLevels}
            onSelect={linePrefix}
          />
          <button
            type="button"
            title={t.bold}
            aria-label={t.bold}
            disabled={preview}
            onClick={() => wrap('**')}
          >
            <strong>B</strong>
          </button>
          <button
            type="button"
            title={t.italic}
            aria-label={t.italic}
            disabled={preview}
            onClick={() => wrap('*')}
          >
            <em>I</em>
          </button>
          <button
            type="button"
            title={t.inlineCode}
            aria-label={t.inlineCode}
            disabled={preview}
            onClick={() => wrap('`')}
          >
            <span role="mono">{'</>'}</span>
          </button>
          <ToolMenu
            icon={<CodeBlockIcon />}
            title={t.codeBlock}
            ariaLabel={t.codeBlockMenu}
            disabled={preview}
            items={codeLanguages}
            onSelect={insertCodeBlock}
          />
          <button
            type="button"
            title={t.link}
            aria-label={t.link}
            disabled={preview}
            onClick={() => wrap('[', '](url)')}
          >
            <LinkIcon />
          </button>
          <button
            type="button"
            title={t.bulletList}
            aria-label={t.bulletList}
            disabled={preview}
            onClick={() => linePrefix('- ')}
          >
            <ListIcon />
          </button>
          <button
            type="button"
            title={t.numberedList}
            aria-label={t.numberedList}
            disabled={preview}
            onClick={() => linePrefix('1. ')}
          >
            <span role="mono">1.</span>
          </button>
          <button
            type="button"
            title={t.quote}
            aria-label={t.quote}
            disabled={preview}
            onClick={() => linePrefix('> ')}
          >
            <QuoteIcon />
          </button>

          <span aria-hidden="true" />
        </div>

        <button
          type="button"
          title={preview ? t.previewExit : t.preview}
          aria-label={t.preview}
          aria-pressed={preview}
          onClick={() => setPreview((current) => !current)}
        >
          <EyeIcon />
        </button>
      </div>

      {preview ? (
        <div role="preview">
          {value.trim() ? <Markdown source={value} /> : <p>{t.emptyPreview}</p>}
        </div>
      ) : (
        <textarea
          ref={textareaRef}
          value={value}
          aria-invalid={overLimit || undefined}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
              if (!onSubmit) return;
              event.preventDefault();
              onSubmit();
            } else if (event.key === 'Escape') {
              if (!onCancel) return;
              event.preventDefault();
              onCancel();
            } else if (event.key === 'Tab' && !event.shiftKey) {
              // Tab dans le textarea = indentation (4 espaces), pas de changement de
              // champ. La sélection est remplacée par les espaces, curseur après.
              event.preventDefault();
              const ta = event.currentTarget;
              const start = ta.selectionStart;
              const end = ta.selectionEnd;
              const indent = '    ';
              onChange(value.slice(0, start) + indent + value.slice(end));
              requestAnimationFrame(() => {
                ta.focus();
                const pos = start + indent.length;
                ta.setSelectionRange(pos, pos);
              });
            }
          }}
          rows={2}
          placeholder={placeholder}
          aria-label="Éditeur Markdown"
          autoFocus={autoFocus}
        />
      )}
      </div>

      {!embedded && (
        <div role="editor-actions">
          {maxLength != null && (
            <span role="editor-status" data-over={overLimit ? '' : undefined}>
              <span role="char-count">
                {value.length} / {maxLength}
              </span>
            </span>
          )}
          <button type="button" onClick={onCancel}>
            {t.cancel}
          </button>
          <button type="button" onClick={onSubmit} disabled={submitDisabled || submitting}>
            {submitting ? <Spinner tone="current" size={16} /> : submitLabel}
          </button>
        </div>
      )}
    </div>
  );
}

interface ToolMenuProps {
  /** Contenu du bouton (icone ou texte). */
  icon: React.ReactNode;
  /** Infobulle / aria-label du bouton. */
  title: string;
  /** Libelle du menu (aria-label de la liste). */
  ariaLabel: string;
  /** Entrees du menu. */
  items: MenuItem[];
  /** Appele avec la `value` de l'entree choisie. */
  onSelect: (value: string) => void;
  disabled?: boolean;
}

/** Bouton de barre d'outils ouvrant un menu deroulant (titres, langages…). */
function ToolMenu({ icon, title, ariaLabel, items, onSelect, disabled }: ToolMenuProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Ferme le menu au clic exterieur ou sur Echap.
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false);
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  // À l'ouverture, si le menu (ancré à gauche par défaut) dépasse le bord droit du
  // viewport, on l'ancre à droite du bouton. Ajustement DOM impératif (mesure →
  // style) dans un layout effect : bascule avant le paint, sans state ni re-render.
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!open || !el) return;
    const margin = 8;
    if (el.getBoundingClientRect().right > window.innerWidth - margin) {
      el.style.left = 'auto';
      el.style.right = '0';
    }
  }, [open]);

  return (
    <div role="menu-wrap" ref={wrapRef}>
      <button
        type="button"
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
      </button>
      {open && (
        <div role="menu" aria-label={ariaLabel} ref={menuRef}>
          {items.map((item) => (
            <button
              key={item.value || 'plain'}
              type="button"
              role="menuitem"
              onClick={() => {
                onSelect(item.value);
                setOpen(false);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function EyeIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinejoin="round"
      />
      <circle cx="8" cy="8" r="1.8" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  );
}

function CodeBlockIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" stroke="currentColor" strokeWidth="1.2" />
      <path
        d="M6 7 4.5 8.5 6 10M10 7l1.5 1.5L10 10"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function LinkIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M6.5 9.5 9.5 6.5M7 5l1-1a2.12 2.12 0 0 1 3 3l-1 1M9 11l-1 1a2.12 2.12 0 0 1-3-3l1-1"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ListIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M5.5 4h7M5.5 8h7M5.5 12h7"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
      <circle cx="2.8" cy="4" r="0.9" fill="currentColor" />
      <circle cx="2.8" cy="8" r="0.9" fill="currentColor" />
      <circle cx="2.8" cy="12" r="0.9" fill="currentColor" />
    </svg>
  );
}

function QuoteIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M4 4v8M7 5h6M7 8h5M7 11h6"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
      />
    </svg>
  );
}
