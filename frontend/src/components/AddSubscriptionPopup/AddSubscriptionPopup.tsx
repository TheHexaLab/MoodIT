import React, { useEffect, useRef, useState } from 'react';
import styles from './AddSubscriptionPopup.module.css';
import { Chevron } from '../../assets/Chevron.tsx';
import { Check } from '../../assets/Check.tsx';
import { MagnifyingGlass } from '../../assets/MagnifyingGlass.tsx';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup.tsx';
import { contrastingTextColor } from '../../helpers/color.ts';
import { byName, normalize } from './helpers.ts';
import { DEFAULT_COLOR, DEFAULT_PALETTE, FIELD_MAX_LENGTH, defaultLabels } from './labels.ts';
import type {
  AddSubscriptionPopupLabels,
  CreateEstablishment,
  JoinEstablishment,
  JoinSelection,
  MaybePromise,
  NewProgram,
  Program,
} from './types.ts';

// Ré-export de l'API publique : les consommateurs importent toujours ces types depuis ce module.
export type {
  AddSubscriptionPopupLabels,
  CreateEstablishment,
  Establishment,
  JoinEstablishment,
  JoinSelection,
  MaybePromise,
  NewProgram,
  Program,
} from './types.ts';

/** Opération asynchrone en cours (pilote les spinners et le verrouillage). */
type Pending =
  | { kind: 'create' }
  | { kind: 'join' }
  | { kind: 'establishment'; id: number }
  | { kind: 'submit' };

interface AddSubscriptionPopupProps {
  onClose: (...args: unknown[]) => unknown;
  /** Émise à la création avec le programme saisi ; le parent persiste comme il veut. */
  onCreate: (program: NewProgram) => unknown;
  /** Émise à l'ajout avec l'établissement et les programmes sélectionnés. */
  onJoin: (selection: JoinSelection) => unknown;
  /**
   * Obligatoire. Chargé au clic « Créer un programme » : établissements + codes de leurs programmes.
   * Un retour qui n'est pas un tableau (erreur incluse) empêche d'ouvrir le formulaire.
   */
  loadCreateEstablishments: () => MaybePromise<CreateEstablishment[]>;
  /**
   * Obligatoire. Chargé au clic « Rejoindre un programme » : établissements + leur nombre de programmes.
   * Un retour qui n'est pas un tableau empêche d'entrer dans la vue « rejoindre ».
   */
  loadJoinEstablishments: () => MaybePromise<JoinEstablishment[]>;
  /**
   * Obligatoire. Chargé au choix d'un établissement (vue rejoindre) : programmes rattachés.
   * Un retour qui n'est pas un tableau empêche de passer à l'étape de sélection des programmes.
   */
  loadEstablishmentPrograms: (establishmentId: number) => MaybePromise<Program[]>;
  /** Couleurs prédéfinies proposées dans la palette. */
  palette?: string[];
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<AddSubscriptionPopupLabels>;
}

/** Indicateur de chargement (cercle qui tourne ; prend la couleur courante du texte). */
function Spinner(): React.ReactElement {
  return <span className={styles.spinner} aria-hidden="true" />;
}

export function AddSubscriptionPopup({
  onClose,
  onCreate,
  onJoin,
  loadCreateEstablishments,
  loadJoinEstablishments,
  loadEstablishmentPrograms,
  palette = DEFAULT_PALETTE,
  labels,
}: AddSubscriptionPopupProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };

  /** Vue affichée : menu de choix, formulaire de création, ou recherche pour rejoindre. */
  const [view, setView] = useState<'menu' | 'create' | 'join'>('menu');
  /** Opération async en cours : pilote les spinners et empêche les doubles déclenchements. */
  const [pending, setPending] = useState<Pending | null>(null);
  /** Message d'erreur de la dernière opération async (null = aucune). */
  const [error, setError] = useState<string | null>(null);
  /** Composant monté ? Ignore les réponses async qui reviennent après démontage. */
  const mountedRef = useRef(true);
  /** Jeton de la dernière requête async : ignore les réponses périmées (race conditions). */
  const requestRef = useRef(0);

  // Données chargées à la demande par les callbacks (ou repli sur les props statiques).
  const [createEstablishments, setCreateEstablishments] = useState<CreateEstablishment[]>([]);
  const [joinEstablishments, setJoinEstablishments] = useState<JoinEstablishment[]>([]);
  const [establishmentPrograms, setEstablishmentPrograms] = useState<Program[]>([]);

  // Champs du formulaire de création de programme.
  const [color, setColor] = useState(DEFAULT_COLOR);
  const [establishmentId, setEstablishmentId] = useState<number | null>(null);
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [cohort, setCohort] = useState('');

  /** Menu déroulant des établissements ouvert ? */
  const [isEstablishmentOpen, setIsEstablishmentOpen] = useState(false);
  /** Recherche saisie dans le menu établissement. */
  const [establishmentSearch, setEstablishmentSearch] = useState('');
  /** Conteneur du champ établissement (pour le click-outside du menu). */
  const establishmentRef = useRef<HTMLDivElement | null>(null);

  /** Ouvre/ferme le menu établissement en réinitialisant la recherche. */
  function toggleEstablishment(open: boolean) {
    setIsEstablishmentOpen(open);
    setEstablishmentSearch('');
  }

  // Vue « rejoindre » : établissement choisi (null = étape recherche), recherches, programmes cochés.
  const [joinEstablishmentId, setJoinEstablishmentId] = useState<number | null>(null);
  const [joinSearch, setJoinSearch] = useState('');
  const [programSearch, setProgramSearch] = useState('');
  const [selectedProgramIds, setSelectedProgramIds] = useState<number[]>([]);

  const [isClosing, setIsClosing] = useState(false);
  const pendingAction = useRef<(() => void) | null>(null);

  /** Retour au menu (en nettoyant l'erreur). */
  function goMenu() {
    setError(null);
    setView('menu');
  }

  /**
   * Lance un chargement async : spinner (`kind`), gating (tableau valide requis),
   * gestion d'erreur (avec réessai) et garde anti-périmé/démontage.
   * `apply` n'est exécuté — et la vue n'avance — que si les données sont valides.
   */
  async function runLoad<T>(
    kind: Pending,
    load: () => MaybePromise<T[]>,
    apply: (data: T[]) => void
  ) {
    if (pending !== null) return;
    const reqId = ++requestRef.current;
    setError(null);
    setPending(kind);
    try {
      const data = await load();
      if (!mountedRef.current || requestRef.current !== reqId) return; // périmé / démonté
      if (!Array.isArray(data)) {
        setError(t.loadError); // retour invalide → bloque + erreur
        return;
      }
      apply(data);
    } catch {
      if (!mountedRef.current || requestRef.current !== reqId) return;
      setError(t.loadError);
    } finally {
      if (mountedRef.current && requestRef.current === reqId) setPending(null);
    }
  }

  // ── Transitions de vue : avancent uniquement après un retour valide du callback ──
  function enterCreate() {
    runLoad<CreateEstablishment>({ kind: 'create' }, loadCreateEstablishments, (data) => {
      setCreateEstablishments(data);
      // Réinitialise le formulaire à chaque ouverture.
      setEstablishmentId(null);
      setCode('');
      setName('');
      setCohort('');
      setColor(DEFAULT_COLOR);
      setIsEstablishmentOpen(false);
      setEstablishmentSearch('');
      setView('create');
    });
  }

  function enterJoin() {
    runLoad<JoinEstablishment>({ kind: 'join' }, loadJoinEstablishments, (data) => {
      setJoinEstablishments(data);
      setJoinEstablishmentId(null);
      setJoinSearch('');
      setProgramSearch('');
      setSelectedProgramIds([]);
      setView('join');
    });
  }

  function chooseJoinEstablishment(id: number) {
    runLoad<Program>(
      { kind: 'establishment', id },
      () => loadEstablishmentPrograms(id),
      (data) => {
        setEstablishmentPrograms(data);
        setProgramSearch('');
        setSelectedProgramIds([]);
        setJoinEstablishmentId(id); // on n'avance qu'après des données valides
      }
    );
  }

  /** Revient de la sélection des programmes vers la recherche d'établissement. */
  function joinBack() {
    setError(null);
    setJoinEstablishmentId(null);
    setSelectedProgramIds([]);
    setJoinSearch('');
    setProgramSearch('');
  }

  /** Coche/décoche un programme (sélection multiple). */
  function toggleProgram(id: number) {
    setSelectedProgramIds((prev) =>
      prev.includes(id) ? prev.filter((pid) => pid !== id) : [...prev, id]
    );
  }

  // Marque le composant comme démonté : les callbacks async résolus ensuite sont ignorés.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Ferme le menu établissement quand on clique en dehors du champ.
  useEffect(() => {
    if (!isEstablishmentOpen) return;
    function onPointerDown(event: MouseEvent) {
      if (establishmentRef.current && !establishmentRef.current.contains(event.target as Node)) {
        toggleEstablishment(false);
      }
    }
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [isEstablishmentOpen]);

  /** Joue l'animation de sortie puis exécute l'action (fermeture immédiate si reduced-motion). */
  function requestClose(action: () => void) {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      action();
      return;
    }
    pendingAction.current = action;
    setIsClosing(true);
  }

  function handleAnimationEnd(event: React.AnimationEvent<HTMLDivElement>) {
    if (isClosing && event.target === event.currentTarget) {
      pendingAction.current?.();
      pendingAction.current = null;
    }
  }

  // ── Vue « création » : dropdown + unicité du code ──────────────────
  /** Établissement sélectionné dans le formulaire (avec les codes de ses programmes). */
  const selectedEstablishment = createEstablishments.find((e) => e.id === establishmentId);

  /** Établissements du dropdown, triés et filtrés par la recherche. */
  const sortedCreateEstablishments = [...createEstablishments].sort(byName);
  const createQuery = normalize(establishmentSearch);
  const filteredCreateEstablishments =
    createQuery === ''
      ? sortedCreateEstablishments
      : sortedCreateEstablishments.filter((e) => normalize(e.name).includes(createQuery));

  /** Le code saisi existe-t-il déjà dans l'établissement choisi ? */
  const trimmedCode = code.trim();
  const codeTaken =
    selectedEstablishment !== undefined &&
    trimmedCode !== '' &&
    selectedEstablishment.programCodes.some((c) => c.toUpperCase() === trimmedCode.toUpperCase());

  const canSubmit =
    trimmedCode !== '' &&
    name.trim() !== '' &&
    cohort.trim() !== '' &&
    establishmentId !== null &&
    !codeTaken;

  async function submit() {
    if (!canSubmit || pending !== null) return;
    const program: NewProgram = {
      name: name.trim(),
      code: trimmedCode,
      cohort: cohort.trim(),
      color,
      establishmentId,
    };
    const reqId = ++requestRef.current;
    setError(null);
    setPending({ kind: 'submit' });
    try {
      // onCreate peut être async (POST) : on attend sa résolution avant de fermer.
      await onCreate(program);
      if (!mountedRef.current || requestRef.current !== reqId) return;
      requestClose(onClose); // succès → ferme via onClose
    } catch {
      // Échec → le popup reste ouvert et affiche l'erreur.
      if (!mountedRef.current || requestRef.current !== reqId) return;
      setError(t.saveError);
    } finally {
      if (mountedRef.current && requestRef.current === reqId) setPending(null);
    }
  }

  // ── Vue « rejoindre » ──────────────────────────────────────────────
  /** Établissements triés et filtrés par la recherche de la vue « rejoindre ». */
  const sortedJoinEstablishments = [...joinEstablishments].sort(byName);
  const joinQuery = normalize(joinSearch);
  const filteredJoinEstablishments =
    joinQuery === ''
      ? sortedJoinEstablishments
      : sortedJoinEstablishments.filter((e) => normalize(e.name).includes(joinQuery));

  /** Établissement choisi dans la vue « rejoindre » (ou undefined à l'étape recherche). */
  const joinEstablishment = joinEstablishments.find((e) => e.id === joinEstablishmentId);

  /** Programmes de l'établissement choisi, triés par nom, filtrés par la recherche. */
  const sortedPrograms = [...establishmentPrograms].sort(byName);
  const programQuery = normalize(programSearch);
  const filteredPrograms =
    programQuery === ''
      ? sortedPrograms
      : sortedPrograms.filter((p) =>
          normalize(`${p.name} ${p.code} ${p.cohort}`).includes(programQuery)
        );

  async function join() {
    if (joinEstablishmentId === null || selectedProgramIds.length === 0 || pending !== null) return;
    const selection: JoinSelection = {
      establishmentId: joinEstablishmentId,
      programIds: selectedProgramIds,
    };
    const reqId = ++requestRef.current;
    setError(null);
    setPending({ kind: 'submit' });
    try {
      // onJoin peut être async (POST) : on attend sa résolution avant de fermer.
      await onJoin(selection);
      if (!mountedRef.current || requestRef.current !== reqId) return;
      requestClose(onClose); // succès → ferme via onClose
    } catch {
      if (!mountedRef.current || requestRef.current !== reqId) return;
      setError(t.saveError);
    } finally {
      if (mountedRef.current && requestRef.current === reqId) setPending(null);
    }
  }

  // ── En-tête (titre, sous-titre, action « retour ») selon la vue/étape ──
  const headerBack: (() => void) | null =
    view === 'create'
      ? goMenu
      : view === 'join'
        ? joinEstablishmentId !== null
          ? joinBack
          : goMenu
        : null;

  const headerTitle =
    view === 'menu'
      ? t.title
      : view === 'create'
        ? t.createTitle
        : joinEstablishmentId !== null
          ? (joinEstablishment?.name ?? t.joinTitle)
          : t.joinTitle;

  const headerSubtitle =
    view === 'menu'
      ? t.subtitle
      : view === 'create'
        ? t.createSubtitle
        : joinEstablishmentId === null
          ? t.joinSearchSubtitle
          : t.joinProgramsSubtitle;

  // ── Animation de transition entre étapes ────────────────────────────
  // Profondeur de l'étape courante : menu (0) → création / recherche (1) → programmes (2).
  const stepDepth = view === 'menu' ? 0 : view === 'join' && joinEstablishmentId !== null ? 2 : 1;
  // Clé d'étape : un changement remonte le conteneur, ce qui rejoue l'animation d'entrée.
  const stepKey =
    view === 'menu'
      ? 'menu'
      : view === 'create'
        ? 'create'
        : joinEstablishmentId !== null
          ? 'join-programs'
          : 'join-search';
  // Sens de l'animation, ajusté pendant le rendu quand la profondeur change
  // (motif React « adjusting state during render ») : recul si on remonte la pile.
  const [stepState, setStepState] = useState<{ depth: number; direction: 'forward' | 'back' }>({
    depth: stepDepth,
    direction: 'forward',
  });
  if (stepState.depth !== stepDepth) {
    setStepState({ depth: stepDepth, direction: stepDepth < stepState.depth ? 'back' : 'forward' });
  }
  const stepDirection = stepState.direction;

  // ── Contenu par étape ───────────────────────────────────────────────
  // Chaque étape est un bloc JSX du même scope de rendu que le `return` (les handlers y
  // restent de simples gestionnaires d'événement). Seul le bloc de l'étape courante est
  // monté dans le conteneur animé `div.body` ci-dessous.

  /** Étape 0 — menu : choix « créer » ou « rejoindre ». */
  const menuStep: React.ReactElement = (
    <nav className={styles.options}>
      <button type="button" disabled={pending !== null} onClick={enterCreate}>
        <span>+</span>
        <div>
          <span>{t.createTitle}</span>
          <span>{t.createSubtitle}</span>
        </div>
        {pending?.kind === 'create' ? (
          <Spinner />
        ) : (
          <Chevron className={styles.chevron} width="1rem" height="1rem" />
        )}
      </button>
      <button type="button" disabled={pending !== null} onClick={enterJoin}>
        <span>↪</span>
        <div>
          <span>{t.joinTitle}</span>
          <span>{t.joinSubtitle}</span>
        </div>
        {pending?.kind === 'join' ? (
          <Spinner />
        ) : (
          <Chevron className={styles.chevron} width="1rem" height="1rem" />
        )}
      </button>
    </nav>
  );

  /** Étape 1a — création : palette de couleurs, établissement, code/nom/cohorte. */
  const createStep: React.ReactElement = (
    <>
      <section className={styles['color-group']}>
        <span className={styles.preview} style={{ background: color }} aria-hidden="true">
          <span style={{ color: contrastingTextColor(color) }}>
            {code.trim().slice(0, 3) || '?'}
          </span>
        </span>
        <div className={styles['palette-group']}>
          <span className={styles['field-label']}>{t.colorLabel}</span>
          <div className={styles.palette}>
            {palette.map((swatch, index) => {
              const selected = swatch.toLowerCase() === color.toLowerCase();
              return (
                <button
                  key={`${swatch}-${index}`}
                  type="button"
                  className={`${styles.swatch}${selected ? ` ${styles.selected}` : ''}`}
                  style={{ ['--swatch-color']: swatch, background: swatch } as React.CSSProperties}
                  aria-label={swatch}
                  aria-pressed={selected}
                  onClick={() => setColor(swatch)}
                />
              );
            })}
            <label className={styles['add-color']} aria-label={t.addColorLabel}>
              +
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
          </div>
        </div>
      </section>

      <section className={styles.select} ref={establishmentRef}>
        <span className={styles['field-label']}>{t.establishmentLabel}</span>
        <div
          className={`${styles['select-control']}${isEstablishmentOpen ? ` ${styles.open}` : ''}`}
          onClick={() => toggleEstablishment(!isEstablishmentOpen)}
        >
          <span className={selectedEstablishment ? undefined : styles.placeholder}>
            {selectedEstablishment ? selectedEstablishment.name : t.establishmentPlaceholder}
          </span>
          <Chevron
            className={`${styles.chevron}${isEstablishmentOpen ? ` ${styles['chevron-open']}` : ''}`}
            width="1rem"
            height="1rem"
          />
        </div>
        {isEstablishmentOpen && (
          <div className={styles.picker}>
            <div className={styles['picker-search']}>
              <MagnifyingGlass width="1rem" height="1rem" />
              <input
                type="text"
                placeholder={t.searchPlaceholder}
                autoFocus
                value={establishmentSearch}
                onChange={(e) => setEstablishmentSearch(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') toggleEstablishment(false);
                }}
              />
            </div>
            <ul>
              {filteredCreateEstablishments.length === 0 ? (
                <li className={styles['picker-empty']}>
                  {createEstablishments.length === 0 ? t.noEstablishments : t.noResults}
                </li>
              ) : (
                filteredCreateEstablishments.map((establishment) => {
                  const selected = establishment.id === establishmentId;
                  return (
                    <li key={establishment.id}>
                      <button
                        type="button"
                        className={selected ? styles.selected : undefined}
                        onClick={() => {
                          setEstablishmentId(establishment.id);
                          toggleEstablishment(false);
                        }}
                      >
                        <span>{establishment.name}</span>
                        {selected && <Check className={styles.check} width="1rem" height="1rem" />}
                      </button>
                    </li>
                  );
                })
              )}
            </ul>
          </div>
        )}
      </section>

      <label className={`${styles.field}${codeTaken ? ` ${styles.invalid}` : ''}`}>
        <span>{t.codeLabel}</span>
        <div>
          <input
            type="text"
            placeholder={t.codePlaceholder}
            maxLength={FIELD_MAX_LENGTH}
            value={code}
            onChange={(e) => setCode(e.target.value.toUpperCase())}
            aria-invalid={codeTaken}
          />
        </div>
        {codeTaken && <span className={styles['field-error']}>{t.codeTaken}</span>}
      </label>

      <label className={styles.field}>
        <span>{t.nameLabel}</span>
        <div>
          <input
            type="text"
            placeholder={t.namePlaceholder}
            maxLength={FIELD_MAX_LENGTH}
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>
      </label>

      <label className={styles.field}>
        <span>{t.cohortLabel}</span>
        <div>
          <input
            type="text"
            placeholder={t.cohortPlaceholder}
            maxLength={FIELD_MAX_LENGTH}
            value={cohort}
            onChange={(e) => setCohort(e.target.value)}
          />
        </div>
      </label>

      <footer>
        <button type="button" onClick={() => requestClose(onClose)}>
          {t.cancel}
        </button>
        <button type="button" onClick={submit} disabled={!canSubmit || pending !== null}>
          {pending?.kind === 'submit' ? <Spinner /> : t.submit}
        </button>
      </footer>
    </>
  );

  /** Étape 1b — rejoindre / recherche : liste des établissements à choisir. */
  const joinSearchStep: React.ReactElement = (
    // key distincte de l'étape « programmes » : force le remontage du <ul> au changement
    // d'étape, sinon React réutilise le même nœud DOM et garde son scrollTop.
    <section key="join-establishments" className={styles.join}>
      <div className={styles.search}>
        <MagnifyingGlass width="1rem" height="1rem" />
        <input
          type="text"
          placeholder={t.searchPlaceholder}
          autoFocus
          value={joinSearch}
          onChange={(e) => setJoinSearch(e.target.value)}
        />
      </div>
      <ul>
        {filteredJoinEstablishments.length === 0 ? (
          <li className={styles.empty}>
            {joinEstablishments.length === 0 ? t.noEstablishments : t.noResults}
          </li>
        ) : (
          filteredJoinEstablishments.map((establishment) => (
            <li key={establishment.id}>
              <button
                type="button"
                disabled={establishment.programCount === 0 || pending !== null}
                onClick={() => chooseJoinEstablishment(establishment.id)}
              >
                <div>
                  <span>{establishment.name}</span>
                  <span>{t.programCount(establishment.programCount)}</span>
                </div>
                {pending?.kind === 'establishment' && pending.id === establishment.id ? (
                  <Spinner />
                ) : (
                  <Chevron className={styles.go} width="1rem" height="1rem" />
                )}
              </button>
            </li>
          ))
        )}
      </ul>
    </section>
  );

  /** Étape 2 — rejoindre / programmes : sélection multiple des programmes. */
  const joinProgramsStep: React.ReactElement = (
    <>
      <section key="join-programs" className={styles.join}>
        <div className={styles.search}>
          <MagnifyingGlass width="1rem" height="1rem" />
          <input
            type="text"
            placeholder={t.programSearchPlaceholder}
            autoFocus
            value={programSearch}
            onChange={(e) => setProgramSearch(e.target.value)}
          />
        </div>
        <ul>
          {filteredPrograms.length === 0 ? (
            <li className={styles.empty}>
              {establishmentPrograms.length === 0 ? t.noPrograms : t.noResults}
            </li>
          ) : (
            filteredPrograms.map((program) => {
              const selected = selectedProgramIds.includes(program.id);
              return (
                <li key={program.id}>
                  <button
                    type="button"
                    className={selected ? styles.selected : undefined}
                    aria-pressed={selected}
                    onClick={() => toggleProgram(program.id)}
                  >
                    <span
                      className={styles.swatch}
                      style={{
                        background: program.color,
                        color: contrastingTextColor(program.color),
                      }}
                    >
                      {program.code.slice(0, 3)}
                    </span>
                    <div>
                      <span>{program.name}</span>
                      <span>{program.cohort}</span>
                    </div>
                    {selected && <Check className={styles.check} width="1rem" height="1rem" />}
                  </button>
                </li>
              );
            })
          )}
        </ul>
      </section>

      <footer>
        <button type="button" onClick={() => requestClose(onClose)}>
          {t.cancel}
        </button>
        <button
          type="button"
          onClick={join}
          disabled={selectedProgramIds.length === 0 || pending !== null}
        >
          {pending?.kind === 'submit' ? <Spinner /> : t.add}
        </button>
      </footer>
    </>
  );

  // Bloc de l'étape courante, injecté dans le conteneur animé.
  const stepContent =
    view === 'menu'
      ? menuStep
      : view === 'create'
        ? createStep
        : joinEstablishmentId === null
          ? joinSearchStep
          : joinProgramsStep;

  return (
    <>
      <div
        className={`${styles['add-subscription']}${isClosing ? ` ${styles.closing}` : ''}`}
        onClick={(event) => {
          if (event.target === event.currentTarget) requestClose(onClose);
        }}
      >
        <div onAnimationEnd={handleAnimationEnd}>
          <header>
            <div className={styles['header-main']}>
              {headerBack && (
                <button
                  type="button"
                  className={styles.back}
                  aria-label={t.back}
                  disabled={pending !== null}
                  onClick={headerBack}
                >
                  <Chevron className={styles['back-chevron']} width="1.125rem" height="1.125rem" />
                </button>
              )}
              <div>
                <h1>{headerTitle}</h1>
                <p>{headerSubtitle}</p>
              </div>
            </div>
            <button type="button" onClick={() => requestClose(onClose)}>
              ✕
            </button>
          </header>
          <div className={styles.body} key={stepKey} data-dir={stepDirection}>
            {stepContent}
          </div>
        </div>
      </div>

      {error && (
        <ErrorPopup
          content={error}
          labels={{ title: t.errorTitle, close: t.errorClose }}
          onClose={() => setError(null)}
        />
      )}
    </>
  );
}
