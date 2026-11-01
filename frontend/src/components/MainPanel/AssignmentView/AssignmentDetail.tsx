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
  onSubmit: (fileName: string) => Promise<unknown>;
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

export function BackLink({ onBack }: { onBack: () => void }): React.ReactElement {
  return (
    <button type="button" className={styles.back} onClick={onBack}>
      <svg {...ICON}>
        <path d="M19 12H5M11 18l-6-6 6-6" />
      </svg>
      Tous les devoirs
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
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);

  // Une remise se remplace jusqu'à la date limite, et jamais après la correction.
  const canSubmit = !submission || (!submission.grade && (!dueAt || new Date(dueAt) >= now));

  function pick(candidate: File | undefined) {
    if (!candidate) return;
    if (!isAcceptedFile(candidate.name, expectedFormats)) {
      setFile(null);
      setError(`Format non accepté. ${formatHint(expectedFormats)}.`);
    } else if (candidate.size > MAX_FILE_BYTES) {
      setFile(null);
      setError('Ce fichier dépasse 25 Mo.');
    } else {
      setFile(candidate);
      setError(null);
    }
  }

  async function send() {
    if (!file) return;
    setSending(true);
    setError(null);
    try {
      await onSubmit(file.name);
      setFile(null);
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
          <strong>{submission.fileName}</strong>
          <br />
          Remis le {formatDateTime(submission.submittedAt)}
          {submission.grade && (
            <>
              <br />
              Note : {submission.grade}
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
              pick(event.dataTransfer.files[0]);
            }}
          >
            <input
              type="file"
              className={styles.fileInput}
              accept={expectedFormats.join(',') || undefined}
              onChange={(event) => pick(event.target.files?.[0])}
            />
            <svg {...ICON} className={styles.dropIcon}>
              <path d="M12 16V5M7 10l5-5 5 5M5 20h14" />
            </svg>
            <span className={styles.dropTitle}>
              {file ? file.name : 'Glissez votre fichier ici'}
            </span>
            <span className={styles.dropHint}>
              {file ? 'Prêt à remettre' : 'ou cliquez pour le choisir'}
            </span>
          </label>
          <p className={styles.hint}>{formatHint(expectedFormats)}</p>
          {error && (
            <p className={styles.fieldError} role="alert">
              {error}
            </p>
          )}
          <button
            type="button"
            className={`${styles.button} ${styles.primary} ${styles.block}`}
            disabled={!file || sending}
            onClick={() => void send()}
          >
            {submission ? 'Remplacer ma remise' : 'Remettre le devoir'}
          </button>
          {dueAt && (
            <p className={styles.hint}>
              Vous pouvez remplacer votre fichier jusqu'à la date limite.
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
}: AssignmentDetailProps): React.ReactElement {
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
        <SubmissionCard assignment={assignment} now={now} onSubmit={onSubmit} />
      </aside>
    </div>
  );
}
