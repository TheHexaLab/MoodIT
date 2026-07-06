import React, { useEffect, useRef, useState } from 'react';
import styles from './AddSubscriptionPopup.module.css';
import { Spinner as BaseSpinner } from '../Spinner/Spinner.tsx';
import { Chevron } from '../../assets/Chevron.tsx';
import { Check } from '../../assets/Check.tsx';
import { Pencil } from '../../assets/Pencil.tsx';
import { TrashCan } from '../../assets/TrashCan.tsx';
import { MagnifyingGlass } from '../../assets/MagnifyingGlass.tsx';
import { ErrorPopup } from '../ErrorPopup/ErrorPopup.tsx';
import { DeleteConfirmationPopup } from '../DeleteConfirmationPopup/DeleteConfirmationPopup.tsx';
import { contrastingTextColor } from '../../helpers/color.ts';
import type { ManagedEstablishment } from '../../types/domain.ts';
import type { EstablishmentEvent } from '../../services/appSocket.ts';
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

/** Tri des établissements par nom (stable : hors composant pour ne pas être une dépendance). */
const byNameSort = (a: ManagedEstablishment, b: ManagedEstablishment) =>
  a.name.localeCompare(b.name);

/** Opération asynchrone en cours (pilote les spinners et le verrouillage). */
type Pending =
  | { kind: 'create' }
  | { kind: 'join' }
  | { kind: 'establishment'; id: number }
  | { kind: 'manage' }
  | { kind: 'estSave'; id: number | 'new' }
  | { kind: 'estDelete'; id: number }
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
  /**
   * Obligatoire. Ids des programmes auxquels l'utilisateur est déjà abonné.
   * À l'ouverture de l'étape de sélection, ces programmes sont préselectionnés (cochés).
   */
  subscribedProgramIds: number[];
  /** Couleurs prédéfinies proposées dans la palette. */
  palette?: string[];
  /**
   * L'utilisateur peut-il créer un programme ? (réservé aux administrateurs.)
   * Si false, l'option « Créer un programme » du menu n'est pas proposée — seule
   * l'adhésion à un programme existant reste possible. Défaut : true.
   */
  canCreateProgram?: boolean;
  /**
   * L'utilisateur peut-il gérer les établissements ? (réservé aux gardiens.) Si true, une 3e
   * option du menu (« Gérer les établissements ») ouvre une étape de CRUD. Requiert les
   * callbacks `loadEstablishments` / `onCreate|Update|DeleteEstablishment`.
   */
  canManageEstablishments?: boolean;
  /** Charge la liste des établissements (étape « gérer »). */
  loadEstablishments?: () => MaybePromise<ManagedEstablishment[]>;
  /** Crée un établissement ; résout avec l'établissement persisté. */
  onCreateEstablishment?: (name: string, domainEmail: string) => MaybePromise<ManagedEstablishment>;
  /** Modifie un établissement ; résout avec l'établissement à jour. */
  onUpdateEstablishment?: (
    id: number,
    update: { name: string; domainEmail: string }
  ) => MaybePromise<ManagedEstablishment>;
  /** Supprime un établissement (DESTRUCTIF : cascade programmes/cours/membres). */
  onDeleteEstablishment?: (id: number) => MaybePromise<unknown>;
  /**
   * S'abonne aux mises à jour temps réel du catalogue d'établissements (nombre de programmes +
   * codes). Tant que le popup est ouvert, les listes se mettent à jour LIVE par id. Renvoie la
   * fonction de désabonnement.
   */
  subscribeEstablishmentUpdates?: (handler: (event: EstablishmentEvent) => void) => () => void;
  /** Surcharge des textes ; seuls les champs fournis remplacent les défauts. */
  labels?: Partial<AddSubscriptionPopupLabels>;
}

/** Indicateur de chargement (cercle qui tourne ; prend la couleur courante du texte). */
function Spinner(): React.ReactElement {
  return <BaseSpinner tone="current" size={16} />;
}

export function AddSubscriptionPopup({
  onClose,
  onCreate,
  onJoin,
  loadCreateEstablishments,
  loadJoinEstablishments,
  loadEstablishmentPrograms,
  subscribedProgramIds,
  palette = DEFAULT_PALETTE,
  canCreateProgram = true,
  canManageEstablishments = false,
  loadEstablishments,
  onCreateEstablishment,
  onUpdateEstablishment,
  onDeleteEstablishment,
  subscribeEstablishmentUpdates,
  labels,
}: AddSubscriptionPopupProps): React.ReactElement {
  const t = { ...defaultLabels, ...labels };

  /** Vue affichée : menu, création, adhésion, ou gestion des établissements. */
  const [view, setView] = useState<'menu' | 'create' | 'join' | 'manage'>('menu');
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

  // Vue « gérer les établissements » : liste + ligne en édition ('new' = ajout) + brouillon + confirmation.
  const [manageEstablishments, setManageEstablishments] = useState<ManagedEstablishment[]>([]);
  const [estEditing, setEstEditing] = useState<number | 'new' | null>(null);
  const [estName, setEstName] = useState('');
  const [estDomain, setEstDomain] = useState('');
  /** Domaine rejeté par le serveur (409 : déjà utilisé) — affiche une erreur inline dédiée. */
  const [estDomainTaken, setEstDomainTaken] = useState<string | null>(null);
  const [confirmDeleteEst, setConfirmDeleteEst] = useState<ManagedEstablishment | null>(null);

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
    if (!canCreateProgram) return; // garde : création réservée aux administrateurs
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
        // Préselectionne les programmes (de cet établissement) déjà suivis par l'utilisateur.
        setSelectedProgramIds(data.filter((p) => subscribedProgramIds.includes(p.id)).map((p) => p.id));
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

  // ── Vue « gérer les établissements » (gardien) ──────────────────────────────
  /** Entre dans l'étape « gérer » après avoir chargé la liste des établissements. */
  function enterManage() {
    if (!canManageEstablishments || !loadEstablishments) return;
    runLoad<ManagedEstablishment>({ kind: 'manage' }, loadEstablishments, (data) => {
      setManageEstablishments([...data].sort(byNameSort));
      setEstEditing(null);
      setEstName('');
      setEstDomain('');
      setConfirmDeleteEst(null);
      setView('manage');
    });
  }

  // Format du domaine courriel — MÊME règle que la contrainte CHECK de la BD
  // (chk_domain_email : ^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$). La BD garantit aussi l'UNICITÉ
  // (domain_email UNIQUE) : pas de dédup côté front, on valide juste le format ici.
  const estDomainTrimmed = estDomain.trim();
  const estDomainFormatValid = /^[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/.test(estDomainTrimmed);
  /** Le domaine saisi est-il celui que le serveur a refusé (déjà pris) ? */
  const estDomainTakenNow =
    estDomainTaken !== null && estDomainTrimmed !== '' && estDomainTrimmed === estDomainTaken;
  /** Affiche l'état d'erreur si le domaine saisi est mal formé OU déjà pris. */
  const estDomainInvalid = estDomainTrimmed !== '' && (!estDomainFormatValid || estDomainTakenNow);
  const estDraftValid = estName.trim() !== '' && estDomainFormatValid && !estDomainTakenNow;

  function startAddEstablishment() {
    setError(null);
    setEstEditing('new');
    setEstName('');
    setEstDomain('');
    setEstDomainTaken(null);
  }

  function startEditEstablishment(est: ManagedEstablishment) {
    setError(null);
    setEstEditing(est.id);
    setEstName(est.name);
    setEstDomain(est.domainEmail ?? '');
    setEstDomainTaken(null);
  }

  function cancelEstEdit() {
    setEstEditing(null);
    setEstName('');
    setEstDomain('');
    setEstDomainTaken(null);
  }

  /** Crée ou modifie l'établissement en cours d'édition (optimisme géré par le serveur). */
  async function saveEstablishment() {
    if (!estDraftValid || pending !== null) return;
    const name = estName.trim();
    const domainEmail = estDomain.trim();
    const editing = estEditing;
    const reqId = ++requestRef.current;
    setError(null);
    setPending({ kind: 'estSave', id: editing === 'new' ? 'new' : (editing as number) });
    try {
      if (editing === 'new') {
        if (!onCreateEstablishment) return;
        const created = await onCreateEstablishment(name, domainEmail);
        if (!mountedRef.current || requestRef.current !== reqId) return;
        // UPSERT (pas un append aveugle) : l'écho WS `establishment:upserted` peut arriver AVANT
        // cette réponse HTTP et avoir déjà ajouté l'établissement → sinon on le dédouble.
        setManageEstablishments((prev) =>
          (prev.some((e) => e.id === created.id)
            ? prev.map((e) => (e.id === created.id ? created : e))
            : [...prev, created]
          ).sort(byNameSort)
        );
      } else if (typeof editing === 'number') {
        if (!onUpdateEstablishment) return;
        const updated = await onUpdateEstablishment(editing, { name, domainEmail });
        if (!mountedRef.current || requestRef.current !== reqId) return;
        setManageEstablishments((prev) =>
          prev.map((e) => (e.id === editing ? updated : e)).sort(byNameSort)
        );
      }
      cancelEstEdit();
    } catch (e) {
      if (!mountedRef.current || requestRef.current !== reqId) return;
      // 409 (domaine déjà pris) → erreur INLINE sur le champ ; sinon erreur d'ENREGISTREMENT
      // (pas « chargement » : c'est une écriture).
      if (e instanceof Error && e.message === 'duplicate-domain') {
        setEstDomainTaken(domainEmail);
      } else {
        setError(t.saveError);
      }
    } finally {
      if (mountedRef.current && requestRef.current === reqId) setPending(null);
    }
  }

  /** Supprime l'établissement confirmé (DESTRUCTIF : cascade côté BD). */
  async function deleteEstablishmentConfirmed() {
    const target = confirmDeleteEst;
    if (!target || !onDeleteEstablishment || pending !== null) return;
    setConfirmDeleteEst(null);
    const reqId = ++requestRef.current;
    setError(null);
    setPending({ kind: 'estDelete', id: target.id });
    try {
      await onDeleteEstablishment(target.id);
      if (!mountedRef.current || requestRef.current !== reqId) return;
      setManageEstablishments((prev) => prev.filter((e) => e.id !== target.id));
    } catch {
      if (mountedRef.current && requestRef.current === reqId) setError(t.saveError);
    } finally {
      if (mountedRef.current && requestRef.current === reqId) setPending(null);
    }
  }

  // Marque le composant comme démonté : les callbacks async résolus ensuite sont ignorés.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Ref de l'établissement dont on consulte les programmes (lue par le handler WS, stable).
  const joinEstablishmentIdRef = useRef(joinEstablishmentId);
  useEffect(() => {
    joinEstablishmentIdRef.current = joinEstablishmentId;
  });

  // Temps réel (popup ouvert) : le catalogue d'établissements se met à jour LIVE dans les trois
  // listes (créer / rejoindre / gérer). 'catalog' = programmes d'un établissement ; 'upserted' =
  // établissement créé/renommé ; 'deleted' = établissement supprimé.
  useEffect(() => {
    if (!subscribeEstablishmentUpdates) return;
    return subscribeEstablishmentUpdates((event) => {
      if (event.kind === 'catalog') {
        const { establishmentId, programs } = event;
        const programCount = programs.length;
        const programCodes = programs.map((p) => p.code);
        setCreateEstablishments((prev) =>
          prev.map((e) => (e.id === establishmentId ? { ...e, programCodes } : e))
        );
        setJoinEstablishments((prev) =>
          prev.map((e) => (e.id === establishmentId ? { ...e, programCount } : e))
        );
        setManageEstablishments((prev) =>
          prev.map((e) => (e.id === establishmentId ? { ...e, programCount, programCodes } : e))
        );
        // Liste détaillée ouverte sur cet établissement → on la remplace par la liste à jour.
        if (joinEstablishmentIdRef.current === establishmentId) setEstablishmentPrograms(programs);
        return;
      }

      if (event.kind === 'upserted') {
        const { id, name, domainEmail, programCount, programCodes } = event;
        setCreateEstablishments((prev) =>
          prev.some((e) => e.id === id)
            ? prev.map((e) => (e.id === id ? { ...e, name, domainEmail, programCodes } : e))
            : [...prev, { id, name, domainEmail, programCodes }]
        );
        setJoinEstablishments((prev) =>
          prev.some((e) => e.id === id)
            ? prev.map((e) => (e.id === id ? { ...e, name, domainEmail, programCount } : e))
            : [...prev, { id, name, domainEmail, programCount }]
        );
        setManageEstablishments((prev) =>
          (prev.some((e) => e.id === id)
            ? prev.map((e) =>
                e.id === id ? { ...e, name, domainEmail, programCount, programCodes } : e
              )
            : [...prev, { id, name, domainEmail, programCount, programCodes }]
          ).sort(byNameSort)
        );
        return;
      }

      // event.kind === 'deleted'
      const removedId = event.establishmentId;
      setCreateEstablishments((prev) => prev.filter((e) => e.id !== removedId));
      setJoinEstablishments((prev) => prev.filter((e) => e.id !== removedId));
      setManageEstablishments((prev) => prev.filter((e) => e.id !== removedId));
      // Si on consultait justement ses programmes → retour à la recherche.
      if (joinEstablishmentIdRef.current === removedId) {
        setJoinEstablishmentId(null);
        setEstablishmentPrograms([]);
        setSelectedProgramIds([]);
        setProgramSearch('');
      }
    });
  }, [subscribeEstablishmentUpdates]);

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
    (selectedEstablishment.programCodes ?? []).some(
      (c) => c.toUpperCase() === trimmedCode.toUpperCase()
    );

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
    // 0 programme sélectionné est valide : se désabonner de tous ceux de l'établissement.
    if (joinEstablishmentId === null || pending !== null) return;
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
    view === 'create' || view === 'manage'
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
        : view === 'manage'
          ? t.manageEstablishmentsTitle
          : joinEstablishmentId !== null
            ? (joinEstablishment?.name ?? t.joinTitle)
            : t.joinTitle;

  const headerSubtitle =
    view === 'menu'
      ? t.subtitle
      : view === 'create'
        ? t.createSubtitle
        : view === 'manage'
          ? t.manageEstablishmentsSubtitle
          : joinEstablishmentId === null
            ? t.joinSearchSubtitle
            : t.joinProgramsSubtitle;

  // ── Animation de transition entre étapes ────────────────────────────
  // Profondeur de l'étape courante : menu (0) → création / recherche / gérer (1) → programmes (2).
  const stepDepth = view === 'menu' ? 0 : view === 'join' && joinEstablishmentId !== null ? 2 : 1;
  // Clé d'étape : un changement remonte le conteneur, ce qui rejoue l'animation d'entrée.
  const stepKey =
    view === 'menu'
      ? 'menu'
      : view === 'create'
        ? 'create'
        : view === 'manage'
          ? 'manage'
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
      {canCreateProgram && (
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
      )}
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
      {canManageEstablishments && (
        <button type="button" disabled={pending !== null} onClick={enterManage}>
          <span>⚙</span>
          <div>
            <span>{t.manageEstablishmentsTitle}</span>
            <span>{t.manageEstablishmentsSubtitle}</span>
          </div>
          {pending?.kind === 'manage' ? (
            <Spinner />
          ) : (
            <Chevron className={styles.chevron} width="1rem" height="1rem" />
          )}
        </button>
      )}
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
          disabled={pending !== null}
        >
          {pending?.kind === 'submit' ? <Spinner /> : t.add}
        </button>
      </footer>
    </>
  );

  /**
   * Corps du formulaire d'ajout / d'édition d'un établissement. Structure IDENTIQUE au
   * formulaire d'édition d'une section (SectionEditorPopup.editRowInner) : titre, groupe de
   * champs, actions annuler/enregistrer — le style `est-edit-row` reprend `.edit-row`.
   */
  function establishmentFormInner(titleText: string): React.ReactElement {
    return (
      <>
        <h2>{titleText}</h2>
        <div>
          <div>
            <input
              type="text"
              placeholder={t.establishmentNamePlaceholder}
              maxLength={FIELD_MAX_LENGTH}
              value={estName}
              autoFocus
              onChange={(e) => setEstName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEstablishment();
                if (e.key === 'Escape') cancelEstEdit();
              }}
            />
          </div>
          <div className={estDomainInvalid ? styles.invalid : undefined}>
            <input
              type="text"
              placeholder={t.establishmentDomainPlaceholder}
              value={estDomain}
              aria-invalid={estDomainInvalid}
              onChange={(e) => setEstDomain(e.target.value.toLowerCase())}
              onKeyDown={(e) => {
                if (e.key === 'Enter') saveEstablishment();
                if (e.key === 'Escape') cancelEstEdit();
              }}
            />
          </div>
          {estDomainInvalid && (
            <p className={styles.invalid}>
              {estDomainTakenNow ? t.establishmentDomainTaken : t.establishmentDomainInvalid}
            </p>
          )}
        </div>
        <div>
          <button type="button" onClick={cancelEstEdit} disabled={pending !== null}>
            {t.cancel}
          </button>
          <button
            type="button"
            onClick={saveEstablishment}
            disabled={!estDraftValid || pending !== null}
          >
            {pending?.kind === 'estSave' ? (
              <Spinner />
            ) : estEditing === 'new' ? (
              t.submit
            ) : (
              t.saveEstablishment
            )}
          </button>
        </div>
      </>
    );
  }

  /** Étape « gérer les établissements » : liste + suppression ; ajout/édition via le formulaire. */
  const manageStep: React.ReactElement = (
    <>
      <section key="manage" className={styles.join}>
        <ul className={styles['est-list']}>
          {manageEstablishments.length === 0 && estEditing !== 'new' ? (
            <li className={styles.empty}>{t.noEstablishments}</li>
          ) : (
            manageEstablishments.map((est) =>
              estEditing === est.id ? (
                <li key={est.id} className={styles['est-edit-row']}>
                  {establishmentFormInner(t.editEstablishment)}
                </li>
              ) : (
                <li key={est.id} className={styles['est-row']}>
                  <div className={styles['est-info']}>
                    <span>{est.name}</span>
                    <span>
                      {est.domainEmail}
                      {typeof est.programCount === 'number'
                        ? ` · ${t.programCount(est.programCount)}`
                        : ''}
                    </span>
                  </div>
                  <div className={styles['est-actions']}>
                    {pending?.kind === 'estDelete' && pending.id === est.id ? (
                      <Spinner />
                    ) : (
                      <>
                        <button
                          type="button"
                          aria-label="Modifier"
                          onClick={() => startEditEstablishment(est)}
                          disabled={pending !== null || estEditing !== null}
                        >
                          <Pencil width="1rem" height="1rem" />
                        </button>
                        <button
                          type="button"
                          className={styles['est-danger']}
                          aria-label="Supprimer"
                          onClick={() => setConfirmDeleteEst(est)}
                          disabled={pending !== null || estEditing !== null}
                        >
                          <TrashCan width="1rem" height="1rem" />
                        </button>
                      </>
                    )}
                  </div>
                </li>
              )
            )
          )}
        </ul>
      </section>

      {/* Bouton d'ajout en BAS (ou formulaire d'ajout à sa place) — même schéma que le
          SectionEditorPopup. */}
      <footer className={styles['est-footer']}>
        {estEditing === 'new' ? (
          <div className={styles['est-edit-row']}>{establishmentFormInner(t.addEstablishment)}</div>
        ) : (
          <button
            type="button"
            className={styles['est-add']}
            onClick={startAddEstablishment}
            disabled={pending !== null || estEditing !== null}
          >
            +<span>{t.addEstablishment}</span>
          </button>
        )}
      </footer>
    </>
  );

  // Bloc de l'étape courante, injecté dans le conteneur animé.
  const stepContent =
    view === 'menu'
      ? menuStep
      : view === 'create'
        ? createStep
        : view === 'manage'
          ? manageStep
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

      {confirmDeleteEst && (
        <DeleteConfirmationPopup
          title={t.deleteEstablishmentTitle}
          content={
            `Supprimer « ${confirmDeleteEst.name} » ?` +
            (confirmDeleteEst.programCount
              ? ` Ses ${confirmDeleteEst.programCount} programme(s) et tout leur contenu (cours, membres) seront aussi supprimés.`
              : '') +
            ' Cette action est irréversible.'
          }
          onDeleteConfirmation={deleteEstablishmentConfirmed}
          onClose={() => setConfirmDeleteEst(null)}
        />
      )}
    </>
  );
}
