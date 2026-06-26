import React, { useCallback, useEffect, useRef, useState } from 'react';
import { DeleteConfirmationPopup } from '../DeleteConfirmationPopup/DeleteConfirmationPopup';
import { EditorShell, Portal } from './EditorShell';
import { QuizListBody } from './QuizListPopup';
import { QuizFormBody } from './QuizFormPopup';
import { QuestionFormBody } from './QuestionFormPopup';
import { HarnessBody } from './HarnessPopup';
import { QuestionTestBody } from './QuestionTestPopup';
import {
  type Language,
  type Question,
  type QuestionTypeOption,
  type Quiz,
} from '../../types/domain';
import {
  FALLBACK_LANGUAGES,
  draftToQuestion,
  emptyQuestionDraft,
  questionToDraft,
  type QuestionDraft,
  type QuizEditorHandlers,
  type QuizMetaDraft,
} from './editorTypes';

interface QuizEditorProps {
  /** Cours édité (pour le titre/sous-titre des popups). */
  courseId: number;
  /** Sous-titre contextuel (« Algèbre linéaire · 201-NYC-05 »). */
  courseSubtitle?: string;
  /** Quiz initiaux du cours. */
  quizzes: Quiz[];
  /** Langages disponibles pour les questions Code. */
  languages?: Language[];
  /** Ferme tout l'éditeur. */
  onClose: () => void;
  /** Handlers CRUD (API-ready). Sans eux, l'éditeur opère en mémoire (mock). */
  handlers?: QuizEditorHandlers;
  /**
   * Notifie le parent quand la LISTE des quiz change de façon définitive
   * (création enregistrée, méta mises à jour, suppression, réordre) — pour
   * synchroniser la sidebar. Émis UNIQUEMENT aux commits : ni pendant l'édition
   * d'un quiz (quiz temporaire de création, édits de questions), ni à l'annulation.
   */
  onQuizzesChange?: (quizzes: Quiz[]) => void;
}

type View =
  | { kind: 'list' }
  | { kind: 'form'; quizId: number; isNew: boolean }
  // `quizIsNew` = le QUIZ parent est-il en création (à préserver au retour au form) ;
  // `isNew` = la QUESTION est-elle en création.
  | { kind: 'question'; quizId: number; quizIsNew: boolean; draft: QuestionDraft; isNew: boolean }
  // Harnais de test (question Code) : page empilée sur la question, porte le brouillon
  // courant (édits en cours) pour ne rien perdre à l'aller-retour.
  | { kind: 'harness'; quizId: number; quizIsNew: boolean; draft: QuestionDraft; isNew: boolean }
  // Prévisualisation « Tester » : page empilée qui rend la question comme un étudiant.
  | { kind: 'test'; quizId: number; quizIsNew: boolean; draft: QuestionDraft; isNew: boolean };

type Pending =
  | { kind: 'quiz'; id: number; title: string }
  | { kind: 'question'; quizId: number; id: number };

/**
 * Orchestrateur de l'éditeur de quiz (enseignant) : empile les popups
 * liste → formulaire de quiz → éditeur de question (+ harnais) et les
 * confirmations de suppression. Conserve une copie de travail des quiz pour que
 * tout soit visible immédiatement, et délègue la persistance aux `handlers`.
 */
export function QuizEditor({
  courseId,
  courseSubtitle,
  quizzes: initialQuizzes,
  languages,
  onClose,
  handlers = {},
  onQuizzesChange,
}: QuizEditorProps): React.ReactElement {
  const [quizzes, setQuizzes] = useState<Quiz[]>(initialQuizzes);
  const [view, setView] = useState<View>({ kind: 'list' });
  const [pendingDelete, setPendingDelete] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // À l'ouverture, l'éditeur charge la liste COMPLÈTE (brouillons compris) ; la prop
  // `initialQuizzes` (quiz publiés, venue de la sidebar) sert d'affichage immédiat.
  const fetchQuizzes = handlers.onFetchQuizzes;
  useEffect(() => {
    if (!fetchQuizzes) return;
    let cancelled = false;
    Promise.resolve(fetchQuizzes(courseId))
      .then((all) => {
        if (!cancelled) setQuizzes(all);
      })
      .catch(() => {
        /* échec : on garde la liste initiale (publiés) */
      });
    return () => {
      cancelled = true;
    };
  }, [courseId, fetchQuizzes]);

  // Langages chargés PARESSEUSEMENT (au 1er accès à une question Code), puis mis en
  // cache. `effectiveLanguages` = langages chargés > prop ; sinon repli FALLBACK_LANGUAGES
  // (Python + C) appliqué côté enfants (param par défaut / harnessLanguageName).
  const [loadedLanguages, setLoadedLanguages] = useState<Language[] | null>(null);
  const languagesRequested = useRef(false);
  const fetchLanguages = handlers.onFetchLanguages;
  const requestLanguages = useCallback(() => {
    if (languagesRequested.current || !fetchLanguages) return;
    languagesRequested.current = true;
    Promise.resolve(fetchLanguages())
      .then((langs) => setLoadedLanguages(langs))
      .catch(() => {
        languagesRequested.current = false; // échec : on pourra réessayer
      });
  }, [fetchLanguages]);
  const effectiveLanguages = loadedLanguages ?? languages;

  // Types de question chargés PARESSEUSEMENT (à l'ouverture d'un éditeur de question),
  // puis mis en cache. Repli (param par défaut côté QuestionFormBody) sinon.
  const [questionTypes, setQuestionTypes] = useState<QuestionTypeOption[] | null>(null);
  const questionTypesRequested = useRef(false);
  const fetchQuestionTypes = handlers.onFetchQuestionTypes;
  const requestQuestionTypes = useCallback(() => {
    if (questionTypesRequested.current || !fetchQuestionTypes) return;
    questionTypesRequested.current = true;
    Promise.resolve(fetchQuestionTypes())
      .then((types) => setQuestionTypes(types))
      .catch(() => {
        questionTypesRequested.current = false;
      });
  }, [fetchQuestionTypes]);

  /** Générateur d'ids temporaires (mode mock) : négatifs, jamais en collision. */
  const tmpId = useRef(-1);
  const nextTmpId = () => tmpId.current--;

  /**
   * Instantané de la liste des quiz pris à l'OUVERTURE du formulaire (création ou
   * édition). « Annuler » y revient → toutes les modifications de la session
   * (méta, ajout/édition/suppression de questions, quiz créé) sont défaites.
   * Mis à null une fois le quiz enregistré (les changements deviennent définitifs).
   */
  const snapshotRef = useRef<Quiz[] | null>(null);

  const quizById = (id: number) => quizzes.find((q) => q.id === id);
  /** Insère/remplace un quiz dans une liste (pur) — réutilisé par l'état ET la notif parent. */
  const upsertInList = (list: Quiz[], quiz: Quiz): Quiz[] => {
    const i = list.findIndex((q) => q.id === quiz.id);
    if (i < 0) return [...list, quiz];
    const next = [...list];
    next[i] = quiz;
    return next;
  };
  const upsertQuiz = (quiz: Quiz) => setQuizzes((prev) => upsertInList(prev, quiz));

  // ───────────────────────────── Quiz (liste) ─────────────────────────────

  async function openEdit(quiz: Quiz) {
    setError(null);
    snapshotRef.current = quizzes; // état à restaurer si « Annuler »
    // Charge le détail (questions) si un fetch est fourni et qu'elles manquent.
    let full = quiz;
    if (handlers.onFetchQuiz && !quiz.questions) {
      try {
        full = await handlers.onFetchQuiz(quiz.id);
        upsertQuiz(full);
      } catch {
        setError('Chargement du quiz impossible.');
      }
    }
    setView({ kind: 'form', quizId: full.id, isNew: false });
  }

  function openCreate() {
    snapshotRef.current = quizzes; // état SANS le nouveau quiz : « Annuler » le retire
    const draft: Quiz = {
      id: nextTmpId(),
      title: '',
      isPublished: false,
      isDaily: false,
      questions: [],
    };
    upsertQuiz(draft);
    setView({ kind: 'form', quizId: draft.id, isNew: true });
  }

  function reorderQuizzes(quizIds: number[]) {
    const next = quizIds.map((id) => quizzes.find((q) => q.id === id)!).filter(Boolean);
    setQuizzes(next);
    onQuizzesChange?.(next); // commit : la sidebar reflète le nouvel ordre
    void handlers.onReorderQuizzes?.(courseId, quizIds);
  }

  async function saveQuizMeta(quizId: number, isNew: boolean, meta: QuizMetaDraft) {
    setSaving(true);
    setError(null);
    try {
      const current = quizById(quizId);
      // UN SEUL appel : méta du formulaire + questions éditées en mémoire pendant
      // la session. C'est le point de centralisation de la persistance.
      const payload: Quiz = {
        ...current,
        id: quizId,
        ...meta,
        questions: current?.questions ?? [],
      };
      let next: Quiz[];
      if (isNew && handlers.onCreateQuiz) {
        const created = await handlers.onCreateQuiz(courseId, payload);
        // Réconcilie le quiz temporaire avec la version persistée (ids serveur).
        next = quizzes.map((q) => (q.id === quizId ? created : q));
        setQuizzes(next);
        setView({ kind: 'form', quizId: created.id, isNew: false });
      } else {
        const saved = !isNew ? await handlers.onUpdateQuiz?.(quizId, payload) : undefined;
        next = upsertInList(quizzes, saved ?? payload);
        setQuizzes(next);
        if (isNew) setView({ kind: 'form', quizId, isNew: false });
      }
      // Enregistré : les changements de la session deviennent définitifs.
      snapshotRef.current = null;
      // commit : remonte la liste (nouveau quiz / titre / statut / questions à jour).
      onQuizzesChange?.(next);
    } catch {
      setError("L'enregistrement a échoué. Réessayez.");
    } finally {
      setSaving(false);
    }
  }

  async function confirmDelete() {
    if (!pendingDelete) return;
    const target = pendingDelete;
    setPendingDelete(null);
    try {
      if (target.kind === 'quiz') {
        await handlers.onDeleteQuiz?.(target.id);
        const next = quizzes.filter((q) => q.id !== target.id);
        setQuizzes(next);
        onQuizzesChange?.(next); // commit : retire le quiz de la sidebar
      } else {
        // Suppression EN MÉMOIRE : persistée à l'« Enregistrer » du quiz.
        const quiz = quizById(target.quizId);
        if (quiz) {
          upsertQuiz({ ...quiz, questions: (quiz.questions ?? []).filter((x) => x.id !== target.id) });
        }
      }
    } catch {
      setError('La suppression a échoué.');
    }
  }

  // ─────────────────────────────── Questions ───────────────────────────────

  function openAddQuestion(quizId: number, quizIsNew: boolean) {
    setView({
      kind: 'question',
      quizId,
      quizIsNew,
      draft: emptyQuestionDraft('single_choice'),
      isNew: true,
    });
  }

  function openEditQuestion(quizId: number, quizIsNew: boolean, question: Question) {
    setView({ kind: 'question', quizId, quizIsNew, draft: questionToDraft(question), isNew: false });
  }

  // Enregistre une question EN MÉMOIRE : aucun appel API ici. La persistance se
  // fait en un seul coup à l'« Enregistrer » du quiz (cf. saveQuizMeta), qui envoie
  // méta + questions. « Annuler » du formulaire défait donc proprement ces édits.
  function saveQuestion(quizId: number, quizIsNew: boolean, draft: QuestionDraft) {
    const quiz = quizById(quizId);
    if (!quiz) return;
    const saved = draftToQuestion(draft, draft.id ?? nextTmpId(), languages);
    const existing = quiz.questions ?? [];
    const i = existing.findIndex((q) => q.id === saved.id);
    const questions = i < 0 ? [...existing, saved] : existing.map((q) => (q.id === saved.id ? saved : q));
    upsertQuiz({ ...quiz, questions });
    setError(null);
    // Retour au formulaire en préservant le statut « nouveau quiz ».
    setView({ kind: 'form', quizId, isNew: quizIsNew });
  }

  // Réordonne EN MÉMOIRE : le nouvel ordre est persisté à l'« Enregistrer » du quiz.
  function reorderQuestions(quizId: number, questionIds: number[]) {
    const quiz = quizById(quizId);
    if (!quiz) return;
    const map = new Map((quiz.questions ?? []).map((q) => [q.id, q]));
    upsertQuiz({ ...quiz, questions: questionIds.map((id) => map.get(id)!).filter(Boolean) });
  }

  /**
   * Annule l'édition du quiz (bouton « Annuler » ET chevron retour) : restaure
   * l'instantané pris à l'ouverture du formulaire — donc TOUTES les modifications
   * de la session sont défaites (création, méta, ajout/édition de questions) — et
   * revient à la liste, sans fermer l'éditeur. Identique en création et en édition.
   */
  function cancelForm() {
    if (snapshotRef.current) {
      setQuizzes(snapshotRef.current);
      snapshotRef.current = null;
    }
    setView({ kind: 'list' });
  }

  // ─────────────────────────────────── Rendu ───────────────────────────────────

  const activeQuiz = view.kind !== 'list' ? quizById(view.quizId) : null;

  // Identité de la vue affichée : sert à réinitialiser le défilement de la coquille
  // à chaque navigation (liste → quiz → question → harnais), pour ne pas hériter du
  // scroll de la vue précédente (ex. harnais ouvert depuis le bas du formulaire).
  const scrollResetKey =
    view.kind === 'list'
      ? 'list'
      : view.kind === 'form'
        ? `form-${view.quizId}`
        : `${view.kind}-${view.quizId}-${view.draft.id ?? 'new'}`;

  // En-tête de la coquille selon la vue (la coquille est UNIQUE et persistante :
  // son contenu + sa taille changent, ce qui anime le resize au changement de vue).
  const shell =
    view.kind === 'list'
      ? {
          title: 'Modifier les quiz',
          subtitle: 'Glisse pour réorganiser · une seule édition quotidienne (★)',
          onBack: undefined as (() => void) | undefined,
          width: '29rem',
          // Liste + formulaire de quiz : pas de défilement global (la liste des
          // questions a son propre défilement interne, plafonnée à 17rem).
          scrollBody: false,
          desktopMaxVh: undefined as number | undefined,
        }
      : view.kind === 'form'
        ? {
            title: view.isNew ? 'Nouveau quiz' : 'Modifier le quiz',
            subtitle: courseSubtitle,
            onBack: cancelForm,
            width: '34rem',
            scrollBody: false,
            desktopMaxVh: undefined as number | undefined,
          }
        : view.kind === 'question'
          ? {
              title: view.isNew ? 'Nouvelle question' : 'Modifier la question',
              subtitle: activeQuiz ? questionSubtitle(activeQuiz, view.draft, view.isNew) : undefined,
              onBack: () => setView({ kind: 'form', quizId: view.quizId, isNew: view.quizIsNew }),
              width: '34rem',
              // Éditeur de question : header + actions figés, corps défilant.
              scrollBody: true,
              // Desktop : limite la hauteur à 60vh (le corps défile au-delà).
              desktopMaxVh: 60,
            }
          : view.kind === 'harness'
            ? {
                // Page « Harnais de test » : empilée sur la question (chevron retour).
                title: 'Harnais de test',
                subtitle: activeQuiz ? questionSubtitle(activeQuiz, view.draft, view.isNew) : undefined,
                onBack: () =>
                  setView({
                    kind: 'question',
                    quizId: view.quizId,
                    quizIsNew: view.quizIsNew,
                    draft: view.draft,
                    isNew: view.isNew,
                  }),
                width: '34rem',
                // Corps défilant (les harnais + leurs zones de code peuvent dépasser).
                scrollBody: true,
                desktopMaxVh: 60,
              }
            : {
                // Page « Tester » : prévisualisation de la question (chevron retour).
                title: 'Tester la question',
                subtitle: activeQuiz ? questionSubtitle(activeQuiz, view.draft, view.isNew) : undefined,
                onBack: () =>
                  setView({
                    kind: 'question',
                    quizId: view.quizId,
                    quizIsNew: view.quizIsNew,
                    draft: view.draft,
                    isNew: view.isNew,
                  }),
                width: '34rem',
                scrollBody: true,
                desktopMaxVh: 60,
              };

  return (
    <>
      <EditorShell
        title={shell.title}
        subtitle={shell.subtitle}
        onBack={shell.onBack}
        onClose={onClose}
        width={shell.width}
        scrollBody={shell.scrollBody}
        desktopMaxVh={shell.desktopMaxVh}
        scrollResetKey={scrollResetKey}
      >
        {view.kind === 'list' && (
          <QuizListBody
            quizzes={quizzes}
            onCreate={openCreate}
            onEdit={openEdit}
            onDelete={(quiz) => setPendingDelete({ kind: 'quiz', id: quiz.id, title: quiz.title })}
            onReorder={reorderQuizzes}
          />
        )}

        {view.kind === 'form' && activeQuiz && (
          <QuizFormBody
            quiz={activeQuiz}
            isNew={view.isNew}
            saving={saving}
            error={error}
            onCancel={cancelForm}
            onSaveMeta={(meta) => saveQuizMeta(view.quizId, view.isNew, meta)}
            onAddQuestion={() => openAddQuestion(view.quizId, view.isNew)}
            onEditQuestion={(q) => openEditQuestion(view.quizId, view.isNew, q)}
            onDeleteQuestion={(q) => setPendingDelete({ kind: 'question', quizId: view.quizId, id: q.id })}
            onReorderQuestions={(ids) => reorderQuestions(view.quizId, ids)}
          />
        )}

        {view.kind === 'question' && activeQuiz && (
          <QuestionFormBody
            draft={view.draft}
            isNew={view.isNew}
            saving={saving}
            error={error}
            languages={effectiveLanguages}
            onRequestLanguages={requestLanguages}
            questionTypes={questionTypes ?? undefined}
            onRequestQuestionTypes={requestQuestionTypes}
            onCancel={() => setView({ kind: 'form', quizId: view.quizId, isNew: view.quizIsNew })}
            onSave={(draft) => saveQuestion(view.quizId, view.quizIsNew, draft)}
            onManageHarness={(draft) =>
              setView({
                kind: 'harness',
                quizId: view.quizId,
                quizIsNew: view.quizIsNew,
                draft,
                isNew: view.isNew,
              })
            }
            onTest={(draft) =>
              setView({
                kind: 'test',
                quizId: view.quizId,
                quizIsNew: view.quizIsNew,
                draft,
                isNew: view.isNew,
              })
            }
          />
        )}

        {view.kind === 'harness' && activeQuiz && (
          <HarnessBody
            testCases={view.draft.testCases ?? []}
            language={harnessLanguageName(view.draft.languageId, effectiveLanguages ?? FALLBACK_LANGUAGES)}
            onRequestLanguages={requestLanguages}
            onCancel={() =>
              setView({
                kind: 'question',
                quizId: view.quizId,
                quizIsNew: view.quizIsNew,
                draft: view.draft,
                isNew: view.isNew,
              })
            }
            onSave={(testCases) =>
              setView({
                kind: 'question',
                quizId: view.quizId,
                quizIsNew: view.quizIsNew,
                draft: { ...view.draft, testCases },
                isNew: view.isNew,
              })
            }
          />
        )}

        {view.kind === 'test' && activeQuiz && (
          <QuestionTestBody
            draft={view.draft}
            languages={effectiveLanguages}
            onRequestLanguages={requestLanguages}
            onEvaluateCode={handlers.onEvaluateCode}
          />
        )}
      </EditorShell>

      {pendingDelete && (
        <Portal>
          <DeleteConfirmationPopup
            title={pendingDelete.kind === 'quiz' ? 'Supprimer le quiz ?' : 'Supprimer la question ?'}
            content={
              pendingDelete.kind === 'quiz'
                ? 'Le quiz et toutes ses questions, réponses et soumissions seront définitivement supprimés. Cette action est irréversible.'
                : 'La question et ses réponses seront définitivement supprimées. Cette action est irréversible.'
            }
            onDeleteConfirmation={confirmDelete}
            onClose={() => setPendingDelete(null)}
          />
        </Portal>
      )}
    </>
  );
}

/**
 * Langage (nom) dans lequel s'écrivent les harnais d'une question, pour la coloration :
 * le langage de la question peut désigner un AUTRE langage de harnais via
 * `Language.harnessLanguageId` (sinon = le langage de la question lui-même).
 */
function harnessLanguageName(
  languageId: number | undefined,
  languages: Language[]
): string | undefined {
  const questionLang = languages.find((l) => l.id === languageId);
  if (!questionLang) return undefined;
  const harnessLang =
    questionLang.harnessLanguageId != null
      ? languages.find((l) => l.id === questionLang.harnessLanguageId)
      : undefined;
  return (harnessLang ?? questionLang).name;
}

/** Sous-titre de l'éditeur de question : « Question # ». */
function questionSubtitle(quiz: Quiz, draft: QuestionDraft, isNew: boolean): string {
  const questions = quiz.questions ?? [];
  if (isNew) return `Question ${questions.length + 1}`;
  const index = questions.findIndex((q) => q.id === draft.id);
  return `Question ${index >= 0 ? index + 1 : ''}`.trim();
}
