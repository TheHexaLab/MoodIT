import React, { useState } from 'react';
import styles from './AssignmentView.module.css';
import { StatusPill } from './AssignmentList.tsx';
import type { Assignment } from '../../../types/domain.ts';
import {
  MAX_FILE_BYTES,
  dueBadge,
  formatDateTime,
  formatHint,
  isAcceptedFile,
  submissionBadge,
} from './assignmentFormat.ts';

interface AssignmentDetailProps {
  assignment: Assignment;
  now: Date;
  onBack: () => void;
  onSubmit: (fileNames: string[]) => Promise<unknown>;
  /** Carte d'équipe, pour un devoir en équipe. */
  teamCard?: React.ReactNode;
}

const ICON = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
};

export function BackLink({
  onBack,
  label = 'Tous les devoirs',
}: {
  onBack: () => void;
  label?: string;
}): React.ReactElement {
  return (
    <button type="button" className={styles.back} onClick={onBack}>
      <svg {...ICON}>
        <path d="M19 12H5M11 18l-6-6 6-6" />
      </svg>
      {label}
    </button>
  );
}

/** Carte « Votre remise » : l'envoi est simulé tant que le service de fichiers n'existe pas. */
function SubmissionCard({
  assignment,
  now,
  onSubmit,
}: Pick<AssignmentDetailProps, 'assignment' | 'now' | 'onSubmit'>): React.ReactElement {
  const { submission, expectedFormats, dueAt } = assignment;
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Une remise se remplace jusqu'à la date limite, et jamais après la correction.
  const canSubmit = !submission || (!submission.grade && (!dueAt || new Date(dueAt) >= now));

  function pick(candidates: File[]) {
    if (candidates.length === 0) return;
    const accepted: File[] = [];
    let problem: string | null = null;
    for (const candidate of candidates) {
      if (!isAcceptedFile(candidate.name, expectedFormats)) {
        problem = `Format non accepté. ${formatHint(expectedFormats)}.`;
      } else if (candidate.size > MAX_FILE_BYTES) {
        problem = 'Ce fichier dépasse 25 Mo.';
      } else {
        accepted.push(candidate);
      }
    }
    // Un fichier du même nom remplace le précédent.
    setFiles((previous) => [
      ...previous.filter((file) => !accepted.some((added) => added.name === file.name)),
      ...accepted,
    ]);
    setError(problem);
  }

  async function send() {
    setSending(true);
    setError(null);
    try {
      await onSubmit(files.map((file) => file.name));
      setFiles([]);
    } catch {
      setError("La remise n'a pas pu être envoyée. Réessayez.");
    } finally {
      setSending(false);
    }
  }

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>Votre remise</h2>
      <div className={styles.cardPill}>
        <StatusPill
          badge={
            submission
              ? submissionBadge(assignment)
              : { label: 'Pas encore remis', tone: 'neutral' }
          }
        />
      </div>

      {submission && (
        <p className={styles.submitted}>
          {submission.fileNames.map((name) => (
            <React.Fragment key={name}>
              <strong>{name}</strong>
              <br />
            </React.Fragment>
          ))}
          Remis le {formatDateTime(submission.submittedAt)}
          {submission.submittedBy && ` par ${submission.submittedBy}`}
          {submission.grade && (
            <>
              <br />
              Note : {submission.grade}
            </>
          )}
          {submission.comment && (
            <>
              <br />
              Commentaire : {submission.comment}
            </>
          )}
        </p>
      )}

      {canSubmit && (
        <>
          <label
            className={`${styles.drop} ${dragging ? styles.dropActive : ''}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(event) => {
              event.preventDefault();
              setDragging(false);
              pick([...event.dataTransfer.files]);
            }}
          >
            <input
              type="file"
              multiple
              className={styles.fileInput}
              accept={expectedFormats.join(',') || undefined}
              onChange={(event) => {
                pick([...(event.target.files ?? [])]);
                // Rechoisir le même fichier après l'avoir retiré doit redéclencher le choix.
                event.target.value = '';
              }}
            />
            <svg {...ICON} className={styles.dropIcon}>
              <path d="M12 16V5M7 10l5-5 5 5M5 20h14" />
            </svg>
            <span className={styles.dropTitle}>Glissez vos fichiers ici</span>
            <span className={styles.dropHint}>ou cliquez pour les choisir</span>
          </label>
          {files.length > 0 && (
            <ul className={styles.picked}>
              {files.map((file) => (
                <li key={file.name}>
                  <span className={styles.fileName}>{file.name}</span>
                  <button
                    type="button"
                    aria-label={`Retirer ${file.name}`}
                    onClick={() =>
                      setFiles((previous) => previous.filter((f) => f.name !== file.name))
                    }
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
          <p className={styles.hint}>{formatHint(expectedFormats)}</p>
          {error && (
            <p className={styles.fieldError} role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className={`${styles.button} ${styles.primary} ${styles.block}`}
            disabled={files.length === 0 || sending}
            onClick={() => void send()}
          >
            {submission ? 'Remplacer ma remise' : 'Remettre le devoir'}
          </button>
          {dueAt && (
            <p className={styles.hint}>
              Vous pouvez remplacer vos fichiers jusqu'à la date limite.
            </p>
          )}
        </>
      )}
    </div>
  );
}

/** Devoir ouvert, côté étudiant : les consignes à gauche, la remise à droite. */
export function AssignmentDetail({
  assignment,
  now,
  onBack,
  onSubmit,
  teamCard,
}: AssignmentDetailProps): React.ReactElement {
  // Sans équipe, rien à remettre : la remise est commune à toute l'équipe.
  const waitsForTeam = assignment.teamSize != null && !assignment.team;
  return (
    <div className={styles.columns}>
      <div className={styles.main}>
        <BackLink onBack={onBack} />
        <div>
          <h1 className={styles.title}>{assignment.title}</h1>
          <p className={styles.meta}>
            {!assignment.submission && <StatusPill badge={dueBadge(assignment, now)} />}
            {assignment.dueAt && <span>{formatDateTime(assignment.dueAt)}</span>}
            {assignment.weight != null && <span>{assignment.weight} % de la note</span>}
            {assignment.publishedBy && <span>Publié par {assignment.publishedBy}</span>}
          </p>
        </div>

        <section className={styles.card} aria-label="Consignes">
          <h2 className={styles.cardTitle}>Consignes</h2>
          {assignment.instructions.split('\n\n').map((paragraph) => (
            <p key={paragraph} className={styles.paragraph}>
              {paragraph}
            </p>
          ))}
        </section>

        {assignment.files.length > 0 && (
          <section className={styles.card} aria-label="Fichiers du devoir">
            <h2 className={styles.cardTitle}>Fichiers du devoir</h2>
            <ul className={styles.files}>
              {assignment.files.map((attached) => (
                <li key={attached.name} className={styles.file}>
                  <svg {...ICON}>
                    <path d="M6 3h9l4 4v14H6zM14 3v5h5" />
                  </svg>
                  <span className={styles.fileName}>{attached.name}</span>
                  <span className={styles.rowMeta}>{attached.size}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <aside className={styles.side} aria-label="Remise">
        {teamCard}
        {!waitsForTeam && <SubmissionCard assignment={assignment} now={now} onSubmit={onSubmit} />}
      </aside>
    </div>
  );
}
