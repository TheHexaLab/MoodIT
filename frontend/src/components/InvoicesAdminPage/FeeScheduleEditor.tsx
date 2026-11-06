import React, { useState } from 'react';
import styles from './InvoicesAdminPage.module.css';
import type { FeeBasis, FeeSchedule } from '../../types/domain.ts';
import {
  creditsLabel,
  formatMoney,
  invoiceFromSchedule,
  invoiceTotal,
  parseAmount,
} from '../InvoicesPage/invoice.ts';

/** Statut en cours de saisie : le prix reste du texte jusqu'à l'enregistrement. */
interface StatusInput {
  key: number;
  id: string;
  label: string;
  price: string;
}

/** Frais en cours de saisie : les montants restent du texte jusqu'à l'enregistrement. */
interface FeeInput {
  key: number;
  label: string;
  detail: string;
  amount: string;
  basis: FeeBasis;
  optional: boolean;
}

interface Draft {
  statuses: StatusInput[];
  dueDate: string;
  /** Taux annuel des intérêts de retard, tel que saisi (« 7 », « 7,5 ») ; vide : aucun. */
  interest: string;
  fees: FeeInput[];
}

/** « 7,5 » ou « 7.5 » → 7.5 ; vide → 0 ; NaN si ce n'est pas un nombre. */
function parseRate(text: string): number {
  const normalized = text.replace(/[\s%]/g, '').replace(',', '.');
  if (!normalized) return 0;
  return /^\d+(\.\d{1,2})?$/.test(normalized) ? Number(normalized) : Number.NaN;
}

/** Frais courants d'une université québécoise, ajoutés d'un clic. */
const COMMON_FEES: { label: string; basis: FeeBasis; optional: boolean }[] = [
  { label: 'Frais afférents', basis: 'perCredit', optional: false },
  { label: 'Frais technologiques', basis: 'perSession', optional: false },
  { label: 'Services aux étudiants', basis: 'perSession', optional: false },
  { label: 'Activités sportives', basis: 'perSession', optional: false },
  { label: 'Association étudiante', basis: 'perSession', optional: true },
  { label: 'Assurance collective', basis: 'perSession', optional: true },
];

/** 13450 → « 134,50 » : un montant tel qu'on le tape. */
function amountText(cents: number): string {
  return (cents / 100).toFixed(2).replace('.', ',');
}

function toDraft(schedule: FeeSchedule): Draft {
  return {
    statuses: schedule.statuses.map((status, index) => ({
      key: index + 1,
      id: status.id,
      label: status.label,
      price: amountText(status.creditPriceCents),
    })),
    dueDate: schedule.dueDate,
    interest: schedule.lateInterestPercent
      ? String(schedule.lateInterestPercent).replace('.', ',')
      : '',
    fees: schedule.fees.map((fee, index) => ({
      key: index + 1,
      label: fee.label,
      detail: fee.detail ?? '',
      amount: amountText(fee.amountCents),
      basis: fee.basis ?? 'perSession',
      optional: fee.optional ?? false,
    })),
  };
}

/** Montant saisi, ou 0 s'il est illisible : pour le simulateur seulement. */
const centsOrZero = (text: string) => {
  const cents = parseAmount(text);
  return Number.isNaN(cents) ? 0 : cents;
};

interface FeeScheduleEditorProps {
  schedule: FeeSchedule;
  /** Nombre d'étudiants par statut : un statut utilisé ne se retire pas. */
  studentCounts: Record<string, number>;
  onSave: (schedule: FeeSchedule) => Promise<unknown>;
}

/**
 * Tarification de la session : les statuts et le prix du crédit de chacun (l'administration peut en
 * ajouter), les frais (par crédit ou pour la session, obligatoires ou facultatifs) et l'échéance.
 * Un simulateur montre la facture qui en découle.
 */
export default function FeeScheduleEditor({
  schedule,
  studentCounts,
  onSave,
}: FeeScheduleEditorProps): React.ReactElement {
  const [draft, setDraft] = useState<Draft>(() => toDraft(schedule));
  const [nextKey, setNextKey] = useState(100);
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [credits, setCredits] = useState('15');
  const [residency, setResidency] = useState(schedule.statuses[0]?.id ?? '');
  const [optIn, setOptIn] = useState(true);

  const change = (next: Draft) => {
    setDraft(next);
    setDirty(true);
  };

  const updateStatus = (key: number, patch: Partial<StatusInput>) =>
    change({
      ...draft,
      statuses: draft.statuses.map((status) =>
        status.key === key ? { ...status, ...patch } : status
      ),
    });

  // Un nouveau statut reçoit un identifiant qui ne change plus, même si on le renomme.
  const addStatus = () => {
    change({
      ...draft,
      statuses: [
        ...draft.statuses,
        { key: nextKey, id: `statut-${nextKey}`, label: '', price: '' },
      ],
    });
    setNextKey(nextKey + 1);
  };

  const updateFee = (key: number, patch: Partial<FeeInput>) =>
    change({
      ...draft,
      fees: draft.fees.map((fee) => (fee.key === key ? { ...fee, ...patch } : fee)),
    });

  const addFee = (preset?: (typeof COMMON_FEES)[number]) => {
    change({
      ...draft,
      fees: [
        ...draft.fees,
        {
          key: nextKey,
          label: preset?.label ?? '',
          detail: '',
          amount: '',
          basis: preset?.basis ?? 'perSession',
          optional: preset?.optional ?? false,
        },
      ],
    });
    setNextKey(nextKey + 1);
  };

  // Simulateur : la facture d'un étudiant, avec ce qui est saisi (même pas encore enregistré).
  const namedStatuses = draft.statuses.filter((status) => status.label.trim());
  const simulatedStatus = namedStatuses.some((status) => status.id === residency)
    ? residency
    : (namedStatuses[0]?.id ?? '');
  const simulatedCredits = Math.max(0, Math.min(30, Math.floor(Number(credits) || 0)));
  const preview = invoiceFromSchedule(
    {
      session: schedule.session,
      dueDate: draft.dueDate,
      statuses: draft.statuses.map((status) => ({
        id: status.id,
        label: status.label,
        creditPriceCents: centsOrZero(status.price),
      })),
      fees: draft.fees
        .filter((fee) => fee.label.trim())
        .map((fee) => ({
          label: fee.label.trim(),
          amountCents: centsOrZero(fee.amount),
          basis: fee.basis,
          optional: fee.optional,
        })),
    },
    {
      credits: simulatedCredits,
      residency: simulatedStatus,
      optedOut: optIn
        ? []
        : draft.fees.filter((fee) => fee.optional).map((fee) => fee.label.trim()),
    }
  );

  async function save() {
    const statuses = draft.statuses.map((status) => ({
      id: status.id,
      label: status.label.trim(),
      creditPriceCents: parseAmount(status.price),
    }));
    if (statuses.length === 0) return setError('Ajoutez au moins un statut.');
    if (statuses.some((status) => !status.label || !(status.creditPriceCents > 0))) {
      return setError("Chaque statut a besoin d'un nom et d'un prix du crédit plus grand que 0.");
    }
    const names = statuses.map((status) => status.label.toLowerCase());
    if (new Set(names).size !== names.length) {
      return setError('Deux statuts portent le même nom.');
    }
    if (!draft.dueDate) return setError("Indiquez l'échéance.");
    const interest = parseRate(draft.interest);
    if (Number.isNaN(interest) || interest > 100) {
      return setError('Indiquez un taux d’intérêt entre 0 et 100 % par an.');
    }
    const fees = draft.fees.map((fee) => ({
      label: fee.label.trim(),
      detail: fee.detail.trim() || undefined,
      amountCents: parseAmount(fee.amount),
      basis: fee.basis,
      optional: fee.optional || undefined,
    }));
    if (fees.some((fee) => !fee.label || !(fee.amountCents > 0))) {
      return setError("Chaque frais a besoin d'un libellé et d'un montant plus grand que 0.");
    }
    setError(null);
    setSaving(true);
    try {
      const next: FeeSchedule = {
        session: schedule.session,
        statuses,
        dueDate: draft.dueDate,
        fees,
        lateInterestPercent: interest > 0 ? interest : undefined,
      };
      await onSave(next);
      // Relu tel qu'enregistré : « 315 » devient « 315,00 », « 7,5 % » devient « 7,5 ».
      setDraft(toDraft(next));
      setDirty(false);
    } catch {
      setError("La tarification n'a pas pu être enregistrée. Réessayez.");
    } finally {
      setSaving(false);
    }
  }

  const cancel = () => {
    setDraft(toDraft(schedule));
    setDirty(false);
    setError(null);
  };

  return (
    <div className={styles.editor}>
      <div className={styles.editorMain}>
        {/* Statuts et prix du crédit de chacun ; l'administration peut en ajouter. */}
        <section className={`${styles.card} ${styles.section}`} aria-labelledby="prices-title">
          <h2 id="prices-title" className={styles.cardTitle}>
            Prix du crédit selon le statut
          </h2>
          <p className={styles.hint}>
            Le statut de l'étudiant fixe le prix de ses crédits. Pour un résident du Québec, le
            gouvernement fixe le tarif ; les étudiants français profitent de l'entente
            France-Québec.
          </p>
          <ul className={styles.prices}>
            {draft.statuses.map((status, index) => {
              const name = status.label.trim() || `statut ${index + 1}`;
              const count = studentCounts[status.id] ?? 0;
              return (
                <li key={status.key} className={styles.price}>
                  <div className={styles.priceHead}>
                    <input
                      className={styles.priceName}
                      type="text"
                      value={status.label}
                      maxLength={60}
                      placeholder="Nom du statut"
                      aria-label={`Nom du statut ${index + 1}`}
                      onChange={(event) => updateStatus(status.key, { label: event.target.value })}
                    />
                    {/* Un statut utilisé par des étudiants ne se retire pas : leur facture en dépend. */}
                    {count === 0 && (
                      <button
                        type="button"
                        className={styles.remove}
                        aria-label={`Retirer le statut : ${name}`}
                        onClick={() =>
                          change({
                            ...draft,
                            statuses: draft.statuses.filter((other) => other.key !== status.key),
                          })
                        }
                      >
                        ✕
                      </button>
                    )}
                  </div>
                  <span className={styles.priceInput}>
                    <input
                      type="text"
                      inputMode="decimal"
                      aria-label={`Prix du crédit : ${name}`}
                      value={status.price}
                      placeholder="0,00"
                      onChange={(event) => updateStatus(status.key, { price: event.target.value })}
                    />
                    <span aria-hidden="true">$ / crédit</span>
                  </span>
                  <span className={styles.priceNote}>
                    {count > 0
                      ? `${count} ${count > 1 ? 'étudiants' : 'étudiant'}`
                      : 'Aucun étudiant'}
                  </span>
                </li>
              );
            })}
            <li>
              <button type="button" className={styles.addStatus} onClick={addStatus}>
                + Ajouter un statut
              </button>
            </li>
          </ul>
          {/* Échéance, puis les intérêts qui courent sur le solde impayé une fois passée. */}
          <div className={styles.dueRow}>
            <label className={styles.dueField}>
              <span>Échéance de paiement</span>
              <input
                type="date"
                value={draft.dueDate}
                onChange={(event) => change({ ...draft, dueDate: event.target.value })}
              />
            </label>
            <label className={styles.dueField}>
              <span>Intérêts de retard</span>
              <span className={styles.rateInput}>
                <input
                  type="text"
                  inputMode="decimal"
                  // Nom explicite : sans lui, « % par an » s'ajouterait au nom lu.
                  aria-label="Intérêts de retard"
                  value={draft.interest}
                  placeholder="0"
                  onChange={(event) => change({ ...draft, interest: event.target.value })}
                />
                <span aria-hidden="true">% par an</span>
              </span>
            </label>
          </div>
          <p className={styles.hint}>
            Après l'échéance, les intérêts courent chaque jour sur le solde impayé. Laissez vide
            pour ne pas en facturer.
          </p>
        </section>

        {/* Frais de la session : la liste que l'administration compose. */}
        <section className={`${styles.card} ${styles.section}`} aria-labelledby="fees-title">
          <h2 id="fees-title" className={styles.cardTitle}>
            Frais de la session
          </h2>
          <p className={styles.hint}>
            En plus des droits de scolarité. Un frais facultatif peut être refusé par l'étudiant
            (assurance déjà couverte, par exemple).
          </p>
          {draft.fees.length === 0 ? (
            <p className={styles.emptyFees}>Aucun frais : la facture se limite aux crédits.</p>
          ) : (
            <ul className={styles.fees}>
              {draft.fees.map((fee, index) => {
                const name = fee.label.trim() || `frais ${index + 1}`;
                return (
                  <li key={fee.key} className={styles.fee}>
                    <label className={`${styles.field} ${styles.feeLabel}`}>
                      <span>Libellé</span>
                      <input
                        type="text"
                        value={fee.label}
                        maxLength={80}
                        placeholder="Frais afférents"
                        onChange={(event) => updateFee(fee.key, { label: event.target.value })}
                      />
                    </label>
                    <label className={`${styles.field} ${styles.feeAmount}`}>
                      <span>Montant ($)</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={fee.amount}
                        placeholder="0,00"
                        onChange={(event) => updateFee(fee.key, { amount: event.target.value })}
                      />
                    </label>
                    <div
                      className={styles.segmented}
                      role="radiogroup"
                      aria-label={`Base de calcul : ${name}`}
                    >
                      {(
                        [
                          ['perCredit', 'Par crédit'],
                          ['perSession', 'Par session'],
                        ] as const
                      ).map(([basis, label]) => (
                        <button
                          key={basis}
                          type="button"
                          role="radio"
                          aria-checked={fee.basis === basis}
                          className={fee.basis === basis ? styles.segmentOn : ''}
                          onClick={() => updateFee(fee.key, { basis })}
                        >
                          {label}
                        </button>
                      ))}
                    </div>
                    <label className={styles.optional}>
                      <input
                        type="checkbox"
                        checked={fee.optional}
                        onChange={(event) => updateFee(fee.key, { optional: event.target.checked })}
                      />
                      Facultatif
                    </label>
                    <button
                      type="button"
                      className={styles.remove}
                      aria-label={`Retirer : ${name}`}
                      onClick={() =>
                        change({
                          ...draft,
                          fees: draft.fees.filter((other) => other.key !== fee.key),
                        })
                      }
                    >
                      ✕
                    </button>
                    <label className={`${styles.field} ${styles.feeDetail}`}>
                      <span>Précision (facultatif)</span>
                      <input
                        type="text"
                        value={fee.detail}
                        maxLength={80}
                        placeholder="Précision (facultatif)"
                        onChange={(event) => updateFee(fee.key, { detail: event.target.value })}
                      />
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
          <div className={styles.chips}>
            <button type="button" className={styles.chip} onClick={() => addFee()}>
              + Ajouter un frais
            </button>
            {COMMON_FEES.filter(
              (preset) => !draft.fees.some((fee) => fee.label.trim() === preset.label)
            ).map((preset) => (
              <button
                key={preset.label}
                type="button"
                className={styles.chip}
                onClick={() => addFee(preset)}
              >
                + {preset.label}
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* Simulateur : la facture qui découle de la tarification saisie. */}
      <aside className={`${styles.card} ${styles.simulator}`} aria-labelledby="simulator-title">
        <h2 id="simulator-title" className={styles.cardTitle}>
          Simulateur
        </h2>
        <p className={styles.hint}>La facture d'un étudiant avec cette tarification.</p>
        <div className={styles.simulatorInputs}>
          <label className={styles.field}>
            <span>Crédits</span>
            <input
              type="number"
              min={0}
              max={30}
              value={credits}
              onChange={(event) => setCredits(event.target.value)}
            />
          </label>
          <label className={styles.field}>
            <span>Statut</span>
            <select value={simulatedStatus} onChange={(event) => setResidency(event.target.value)}>
              {namedStatuses.map((status) => (
                <option key={status.key} value={status.id}>
                  {status.label}
                </option>
              ))}
            </select>
          </label>
        </div>
        <label className={styles.optional}>
          <input
            type="checkbox"
            checked={optIn}
            onChange={(event) => setOptIn(event.target.checked)}
          />
          Avec les frais facultatifs
        </label>
        <table className={styles.lines}>
          <caption className={styles.srOnly}>Facture simulée</caption>
          <tbody>
            {preview.lines.map((line) => (
              <tr key={line.label}>
                <th scope="row">
                  {line.label}
                  {line.detail && <span className={styles.lineDetail}>{line.detail}</span>}
                </th>
                <td>{formatMoney(line.amountCents)}</td>
              </tr>
            ))}
            <tr className={styles.linesBalance}>
              <th scope="row">Total pour {creditsLabel(simulatedCredits)}</th>
              <td aria-live="polite">{formatMoney(invoiceTotal(preview))}</td>
            </tr>
          </tbody>
        </table>
      </aside>

      {/* Barre d'enregistrement : visible dès qu'un changement attend. */}
      {(dirty || error) && (
        <div className={styles.saveBar} role="region" aria-label="Changements non enregistrés">
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : (
            <p>
              Changements non enregistrés. Les factures des étudiants changeront à l'enregistrement.
            </p>
          )}
          <span className={styles.spacer} />
          <button type="button" className={styles.button} onClick={cancel}>
            Annuler
          </button>
          <button
            type="button"
            className={`${styles.button} ${styles.primary}`}
            disabled={saving}
            onClick={() => void save()}
          >
            Enregistrer la tarification
          </button>
        </div>
      )}
    </div>
  );
}
