import React, { useEffect, useState } from 'react';
import styles from './AssignmentView.module.css';
import { BackLink } from './AssignmentDetail.tsx';
import { StatusPill } from './AssignmentList.tsx';
import { Spinner } from '../../Spinner/Spinner.tsx';
import type {
  Assignment,
  AssignmentStudentRow,
  SubmissionGrade,
} from '../../../types/domain.ts';
import {
  GRADE_MAX,
  STUDENT_ROW_BADGE,
  clampInput,
  formatDateTime,
  gradeScore,
} from './assignmentFormat.ts';

/** Remarques fréquentes : un clic les ajoute au commentaire, que le prof peut ensuite retoucher. */
const QUICK_COMMENTS = ['Très bon travail.', 'Revoir les cas limites.', 'Rapport à étoffer.'];

/** Formulaire de note d'une remise. Remonté à chaque étudiant : il repart de sa note. */
function GradeForm({
  row,
  hasNext,
  onSave,
  onNext,
}: {
  row: AssignmentStudentRow;
  hasNext: boolean;
  onSave: (grade: SubmissionGrade) => Promise<unknown>;
  onNext: () => void;
}): React.ReactElement {
  const [score, setScore] = useState(gradeScore(row.grade));
  const [comment, setComment] = useState(row.comment ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addQuickComment(text: string) {
    setComment((previous) => (previous.trim() ? `${previous.trim()} ${text}` : text));
    setSaved(false);
  }

  async function save(thenNext: boolean) {
    if (score.trim() === '') {
      setError('Entrez une note.');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await onSave({ score: Number(score), comment: comment.trim() });
      setSaved(true);
      if (thenNext) onNext();
    } catch {
      setError("La note n'a pas pu être enregistrée. Réessayez.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <form
      className={styles.card}
      aria-label="Noter la remise"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save(hasNext);
      }}
    >
      <h2 className={styles.cardTitle}>Note</h2>
      <label className={styles.gradeField}>
        <span className={styles.visuallyHidden}>Note sur {GRADE_MAX}</span>
        <input
          type="number"
          min={0}
          max={GRADE_MAX}
          step={0.5}
          value={score}
          placeholder="—"
          onChange={(event) => {
            setScore(clampInput(event.target.value, GRADE_MAX));
            setSaved(false);
          }}
        />
        <span aria-hidden="true">/ {GRADE_MAX}</span>
      </label>

      <label className={styles.commentField}>
        <span>Commentaire</span>
        <textarea
          rows={5}
          value={comment}
          placeholder="Ce que l'étudiant a bien fait, ce qu'il peut améliorer."
          onChange={(event) => {
            setComment(event.target.value);
            setSaved(false);
          }}
        />
      </label>
      <div className={styles.quickComments} role="group" aria-label="Remarques fréquentes">
        {QUICK_COMMENTS.map((text) => (
          <button
            key={text}
            type="button"
            className={styles.quickComment}
            onClick={() => addQuickComment(text)}
          >
            {text}
          </button>
        ))}
      </div>

      {error && (
        <p className={styles.fieldError} role="alert">
          {error}
        </p>
      )}
      {saved && !error && (
        <p className={styles.savedNote} role="status">
          Note enregistrée.
        </p>
      )}

      <button
        type="submit"
        className={`${styles.button} ${styles.primary} ${styles.block}`}
        disabled={saving}
      >
        {hasNext ? 'Enregistrer et passer au suivant' : 'Enregistrer la note'}
      </button>
      {hasNext && (
        <button
          type="button"
          className={`${styles.button} ${styles.block} ${styles.blockTight}`}
          disabled={saving}
          onClick={() => void save(false)}
        >
          Enregistrer seulement
        </button>
      )}
    </form>
  );
}

/** Page de notation d'une remise : les fichiers à gauche, la note et le commentaire à droite. */
export function SubmissionGrading({
  submissionId,
  onFetch,
  onGrade,
  onBack,
  onOpenSubmission,
}: {
  submissionId: number;
  onFetch: (
    submissionId: number
  ) => Promise<{ assignment: Assignment; rows: AssignmentStudentRow[] }>;
  onGrade: (submissionId: number, grade: SubmissionGrade) => Promise<AssignmentStudentRow>;
  /** Revient au suivi du devoir ; sans devoir connu, à la liste. */
  onBack: (assignmentId?: number) => void;
  onOpenSubmission: (submissionId: number) => void;
}): React.ReactElement {
  const [data, setData] = useState<{
    assignment: Assignment;
    rows: AssignmentStudentRow[];
  } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    onFetch(submissionId)
      .then((loaded) => {
        if (!cancelled) setData(loaded);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [submissionId, onFetch]);

  if (failed) {
    return (
      <div className={styles.main}>
        <BackLink onBack={() => onBack()} />
        <p className={styles.empty} role="alert">
          Cette remise n'existe plus.
        </p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className={styles.state} role="status" aria-busy="true">
        <Spinner size={24} />
        <p>Chargement de la remise…</p>
      </div>
    );
  }

  const { assignment, rows } = data;
  const row = rows.find((candidate) => candidate.id === submissionId);
  if (!row || row.status === 'missing') {
    return (
      <div className={styles.main}>
        <BackLink label="Toutes les remises" onBack={() => onBack(assignment.id)} />
        <p className={styles.empty}>Cet étudiant n'a rien remis.</p>
      </div>
    );
  }

  // On passe d'une remise à l'autre sans repasser par le suivi ; les manquants n'ont rien à noter.
  const submitted = rows.filter((candidate) => candidate.status !== 'missing');
  const position = submitted.indexOf(row);
  const previous = submitted[position - 1];
  const next = submitted[position + 1];

  async function grade(value: SubmissionGrade) {
    const updated = await onGrade(submissionId, value);
    setData(
      (current) =>
        current && {
          ...current,
          rows: current.rows.map((candidate) =>
            candidate.id === updated.id ? updated : candidate
          ),
        }
    );
  }

  return (
    <div className={styles.columns}>
      <div className={styles.main}>
        <BackLink label="Toutes les remises" onBack={() => onBack(assignment.id)} />
        <div className={styles.titleRow}>
          <div className={styles.titleText}>
            <h1 className={styles.title}>{row.studentName}</h1>
            <p className={styles.meta}>
              <StatusPill badge={STUDENT_ROW_BADGE[row.status]} />
              <span>{assignment.title}</span>
              {row.submittedAt && <span>Remis le {formatDateTime(row.submittedAt)}</span>}
            </p>
          </div>
          <nav className={styles.pager} aria-label="Autres remises">
            <button
              type="button"
              className={styles.button}
              disabled={!previous}
              onClick={() => previous && onOpenSubmission(previous.id)}
            >
              Précédent
            </button>
            <span className={styles.rowMeta}>
              {position + 1} sur {submitted.length}
            </span>
            <button
              type="button"
              className={styles.button}
              disabled={!next}
              onClick={() => next && onOpenSubmission(next.id)}
            >
              Suivant
            </button>
          </nav>
        </div>

        {row.members && (
          <section className={styles.card} aria-label="Membres de l'équipe">
            <h2 className={styles.cardTitle}>Membres de l'équipe</h2>
            <ul className={styles.members}>
              {row.members.map((member) => (
                <li key={member}>{member}</li>
              ))}
            </ul>
            <p className={styles.hint}>La note et le commentaire s'appliquent à toute l'équipe.</p>
          </section>
        )}

        <section className={styles.card} aria-label="Fichiers remis">
          <h2 className={styles.cardTitle}>
            {row.files.length > 1 ? `Fichiers remis (${row.files.length})` : 'Fichier remis'}
          </h2>
          <ul className={styles.files}>
            {row.files.map((file) => (
              <li key={file.name} className={styles.file}>
                <span className={styles.fileName}>{file.name}</span>
                <span className={styles.rowMeta}>{file.size}</span>
              </li>
            ))}
          </ul>
        </section>

        <section className={styles.card} aria-label="Consignes du devoir">
          <h2 className={styles.cardTitle}>Consignes du devoir</h2>
          {assignment.instructions.split('\n\n').map((paragraph) => (
            <p key={paragraph} className={styles.paragraph}>
              {paragraph}
            </p>
          ))}
        </section>
      </div>

      <aside className={styles.side} aria-label="Note">
        <GradeForm
          key={row.id}
          row={row}
          hasNext={next != null}
          onSave={grade}
          onNext={() => next && onOpenSubmission(next.id)}
        />
      </aside>
    </div>
  );
}
