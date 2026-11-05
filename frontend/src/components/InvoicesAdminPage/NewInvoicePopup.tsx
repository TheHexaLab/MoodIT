import React, { useState } from 'react';
import styles from './NewInvoicePopup.module.css';
import { Popup } from '../Popup/Popup';
import { PopupVariant } from '../Popup/popupVariant';
import { usePopupController } from '../Popup/popupController';
import type { InvoiceDraft } from '../../types/domain.ts';
import { formatMoney, isoDay, parseAmount } from '../InvoicesPage/invoice.ts';

const WIDTH = { '--popup-width': '44rem' } as React.CSSProperties;

/** Libellés courants, ajoutés d'un clic. */
const COMMON_LINES = ['Droits de scolarité', 'Frais afférents', 'Assurance collective'];

/** Échéance proposée : dans 30 jours. */
const DEFAULT_DUE_DAYS = 30;

interface LineInput {
  key: number;
  label: string;
  detail: string;
  amount: string;
}

interface NewInvoicePopupProps {
  /** « automne 2026 » : la session facturée. */
  session: string;
  now: Date;
  onCreate: (draft: InvoiceDraft) => Promise<unknown>;
  onClose: () => void;
}

/** Nouvelle facture (administration) : l'étudiant, l'échéance et les montants dus. */
export function NewInvoicePopup({
  session,
  now,
  onCreate,
  onClose,
}: NewInvoicePopupProps): React.ReactElement {
  const popup = usePopupController();
  const [studentName, setStudentName] = useState('');
  const [studentEmail, setStudentEmail] = useState('');
  const [dueDate, setDueDate] = useState(() =>
    isoDay(new Date(now.getFullYear(), now.getMonth(), now.getDate() + DEFAULT_DUE_DAYS))
  );
  const [nextKey, setNextKey] = useState(2);
  const [lines, setLines] = useState<LineInput[]>([{ key: 1, label: '', detail: '', amount: '' }]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const total = lines.reduce((sum, line) => {
    const cents = parseAmount(line.amount);
    return Number.isNaN(cents) ? sum : sum + cents;
  }, 0);

  const addLine = (label = '') => {
    // Un clic sur un libellé courant remplit la première ligne encore vide.
    const empty = label
      ? lines.find((line) => !line.label.trim() && !line.amount.trim())
      : undefined;
    if (empty) {
      setLines(lines.map((line) => (line.key === empty.key ? { ...line, label } : line)));
      return;
    }
    setLines([...lines, { key: nextKey, label, detail: '', amount: '' }]);
    setNextKey(nextKey + 1);
  };

  const updateLine = (key: number, change: Partial<LineInput>) =>
    setLines(lines.map((line) => (line.key === key ? { ...line, ...change } : line)));

  async function submit() {
    const name = studentName.trim();
    if (!name) return setError("Indiquez le nom de l'étudiant.");
    if (!dueDate) return setError("Indiquez l'échéance.");
    const parsed = lines.map((line) => ({
      label: line.label.trim(),
      detail: line.detail.trim() || undefined,
      amountCents: parseAmount(line.amount),
    }));
    if (parsed.some((line) => !line.label || !(line.amountCents > 0))) {
      return setError("Chaque ligne a besoin d'un libellé et d'un montant plus grand que 0.");
    }
    setError(null);
    setSaving(true);
    try {
      await onCreate({
        studentName: name,
        studentEmail: studentEmail.trim() || undefined,
        dueDate,
        lines: parsed,
      });
      popup.requestClose(onClose);
    } catch {
      setError("La facture n'a pas pu être émise. Réessayez.");
      setSaving(false);
    }
  }

  return (
    <Popup
      variant={PopupVariant.FormWide}
      label="Nouvelle facture"
      onClose={onClose}
      controller={popup}
      panelStyle={WIDTH}
    >
      <form
        className={styles.form}
        // Les erreurs s'affichent dans la fenêtre, en français, plutôt que par le navigateur.
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <header className={styles.header}>
          <div className={styles.headerText}>
            <h1>Nouvelle facture</h1>
            <p>Session d'{session}</p>
          </div>
          <button
            type="button"
            className={styles.close}
            aria-label="Fermer"
            onClick={() => popup.requestClose(onClose)}
          >
            ✕
          </button>
        </header>

        <div className={styles.body}>
          <div className={styles.row}>
            <label className={styles.field}>
              <span>Étudiant</span>
              <input
                type="text"
                value={studentName}
                maxLength={120}
                placeholder="Camille Lavoie"
                onChange={(event) => setStudentName(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>Courriel (facultatif)</span>
              <input
                type="email"
                value={studentEmail}
                maxLength={160}
                placeholder="camille.lavoie@exemple.ca"
                onChange={(event) => setStudentEmail(event.target.value)}
              />
            </label>
            <label className={styles.field}>
              <span>Échéance</span>
              <input
                type="date"
                value={dueDate}
                onChange={(event) => setDueDate(event.target.value)}
              />
            </label>
          </div>

          <fieldset className={styles.lines}>
            <legend>Montants dus</legend>
            {lines.map((line, index) => (
              <div key={line.key} className={styles.line}>
                <label className={styles.field}>
                  <span>Libellé</span>
                  <input
                    type="text"
                    value={line.label}
                    maxLength={80}
                    placeholder="Droits de scolarité"
                    onChange={(event) => updateLine(line.key, { label: event.target.value })}
                  />
                </label>
                <label className={styles.field}>
                  <span>Précision (facultatif)</span>
                  <input
                    type="text"
                    value={line.detail}
                    maxLength={80}
                    placeholder="15 crédits"
                    onChange={(event) => updateLine(line.key, { detail: event.target.value })}
                  />
                </label>
                <label className={`${styles.field} ${styles.amount}`}>
                  <span>Montant ($)</span>
                  <input
                    type="text"
                    inputMode="decimal"
                    value={line.amount}
                    placeholder="0,00"
                    onChange={(event) => updateLine(line.key, { amount: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className={styles.remove}
                  aria-label={`Retirer la ligne ${index + 1}`}
                  disabled={lines.length === 1}
                  onClick={() => setLines(lines.filter((other) => other.key !== line.key))}
                >
                  ✕
                </button>
              </div>
            ))}

            <div className={styles.chips}>
              <button type="button" className={styles.chip} onClick={() => addLine()}>
                + Ajouter une ligne
              </button>
              {COMMON_LINES.map((label) => (
                <button
                  key={label}
                  type="button"
                  className={styles.chip}
                  onClick={() => addLine(label)}
                >
                  + {label}
                </button>
              ))}
            </div>
          </fieldset>

          <p className={styles.total}>
            <span>Total</span>
            <strong>{formatMoney(total)}</strong>
          </p>

          {error && (
            <p className={styles.error} role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className={styles.footer}>
          <button
            type="button"
            className={styles.button}
            onClick={() => popup.requestClose(onClose)}
          >
            Annuler
          </button>
          <span className={styles.spacer} />
          <button type="submit" className={`${styles.button} ${styles.primary}`} disabled={saving}>
            Émettre la facture
          </button>
        </footer>
      </form>
    </Popup>
  );
}
