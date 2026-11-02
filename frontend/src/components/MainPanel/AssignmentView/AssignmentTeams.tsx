import React, { useEffect, useState } from 'react';
import styles from './AssignmentView.module.css';
import formStyles from './AssignmentFormPopup.module.css';
import { Popup } from '../../Popup/Popup';
import { PopupVariant } from '../../Popup/popupVariant';
import { usePopupController } from '../../Popup/popupController';
import { Spinner } from '../../Spinner/Spinner.tsx';
import type { Assignment, AssignmentTeam, AssignmentTeams } from '../../../types/domain.ts';

const WIDTH = { '--popup-width': '40rem' } as React.CSSProperties;

/** Places prises dans une équipe : vert si elle est complète, jaune s'il reste de la place. */
function TeamCount({ count, max }: { count: number; max: number }): React.ReactElement {
  return (
    <span className={`${styles.teamPill} ${count >= max ? styles.success : styles.warn}`}>
      {count}/{max}
    </span>
  );
}

function MemberList({ members }: { members: string[] }): React.ReactElement {
  return (
    <ul className={styles.members}>
      {members.map((member) => (
        <li key={member}>{member}</li>
      ))}
    </ul>
  );
}

/**
 * Carte d'équipe de l'étudiant. Il voit son équipe ; si les étudiants forment eux-mêmes les équipes,
 * il en rejoint ou en crée une, et peut la quitter tant que l'équipe n'a rien remis.
 */
export function StudentTeamCard({
  assignment,
  onFetchTeams,
  onJoin,
  onCreate,
  onLeave,
}: {
  assignment: Assignment;
  onFetchTeams: () => Promise<AssignmentTeams>;
  onJoin: (teamId: number) => Promise<unknown>;
  onCreate: () => Promise<unknown>;
  onLeave: () => Promise<unknown>;
}): React.ReactElement {
  const { team, teamFormation, teamSize, submission } = assignment;
  const canChoose = teamFormation === 'students';
  const [teams, setTeams] = useState<AssignmentTeam[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (team || !canChoose) return;
    let cancelled = false;
    onFetchTeams()
      .then((loaded) => {
        if (!cancelled) setTeams(loaded.teams);
      })
      .catch(() => {
        if (!cancelled) setError('Impossible de charger les équipes.');
      });
    return () => {
      cancelled = true;
    };
  }, [team, canChoose, onFetchTeams]);

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch {
      setError("L'action n'a pas pu être effectuée. Réessayez.");
    } finally {
      setBusy(false);
    }
  }

  const errorLine = error && (
    <p className={styles.fieldError} role="alert">
      {error}
    </p>
  );

  if (team) {
    return (
      <section className={styles.card} aria-label="Votre équipe">
        <h2 className={styles.cardTitle}>{team.name}</h2>
        <MemberList members={team.members} />
        <p className={styles.hint}>
          Une seule remise par équipe : chaque membre peut la voir et la remplacer.
        </p>
        {errorLine}
        {canChoose && !submission && (
          <button
            type="button"
            className={`${styles.button} ${styles.block}`}
            disabled={busy}
            onClick={() => void run(onLeave)}
          >
            Quitter l'équipe
          </button>
        )}
      </section>
    );
  }

  if (!canChoose) {
    return (
      <section className={styles.card} aria-label="Votre équipe">
        <h2 className={styles.cardTitle}>Votre équipe</h2>
        <p className={styles.hint}>
          Votre prof n'a pas encore formé les équipes. Vous pourrez remettre ce devoir ensuite.
        </p>
      </section>
    );
  }

  return (
    <section className={styles.card} aria-label="Choisir une équipe">
      <h2 className={styles.cardTitle}>Choisir une équipe</h2>
      <p className={styles.hint}>
        {teamSize} membres au maximum. Rejoignez une équipe pour remettre ce devoir.
      </p>
      {errorLine}
      {!teams && !error && (
        <div className={styles.state} role="status" aria-busy="true">
          <Spinner size={20} />
        </div>
      )}
      {teams && (
        <ul className={styles.teamChoices}>
          {teams.map((candidate) => {
            const isFull = candidate.members.length >= (teamSize ?? 0);
            return (
              <li key={candidate.id} className={styles.teamChoice}>
                <div className={styles.teamChoiceLine}>
                  <strong>{candidate.name}</strong>
                  <TeamCount count={candidate.members.length} max={teamSize ?? 0} />
                </div>
                <div className={styles.teamChoiceLine}>
                  <span className={styles.teamChoiceMembers}>{candidate.members.join(', ')}</span>
                  {/* Une équipe complète n'offre aucune action : sa pastille verte le dit. */}
                  {!isFull && (
                    <button
                      type="button"
                      className={styles.gradeAction}
                      disabled={busy}
                      aria-label={`Rejoindre ${candidate.name}`}
                      onClick={() => void run(() => onJoin(candidate.id))}
                    >
                      Rejoindre
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <button
        type="button"
        className={`${styles.button} ${styles.block}`}
        disabled={busy}
        onClick={() => void run(onCreate)}
      >
        Créer une équipe
      </button>
    </section>
  );
}

/** Fenêtre du prof : forme les équipes, ou ajuste celles que les étudiants ont formées. */
export function ManageTeamsPopup({
  assignment,
  onFetch,
  onSave,
  onClose,
}: {
  assignment: Assignment;
  onFetch: () => Promise<AssignmentTeams>;
  onSave: (teams: AssignmentTeam[]) => Promise<unknown>;
  onClose: () => void;
}): React.ReactElement {
  const popup = usePopupController();
  const [teams, setTeams] = useState<AssignmentTeam[] | null>(null);
  const [unassigned, setUnassigned] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  /** Ids négatifs : équipes pas encore enregistrées. */
  const [nextTempId, setNextTempId] = useState(-1);
  const maxSize = assignment.teamSize ?? 0;

  useEffect(() => {
    let cancelled = false;
    onFetch()
      .then((loaded) => {
        if (cancelled) return;
        setTeams(loaded.teams.map((team) => ({ ...team, members: [...team.members] })));
        setUnassigned(loaded.unassigned);
      })
      .catch(() => {
        if (!cancelled) setError('Impossible de charger les équipes.');
      });
    return () => {
      cancelled = true;
    };
  }, [onFetch]);

  /** Premier numéro d'équipe libre : « Équipe 4 » après trois équipes, même si une a été retirée. */
  function newTeam(existing: AssignmentTeam[], id: number): AssignmentTeam {
    let number = existing.length + 1;
    while (existing.some((team) => team.name === `Équipe ${number}`)) number += 1;
    return { id, name: `Équipe ${number}`, members: [] };
  }

  function addTeam() {
    setTeams((previous) => [...(previous ?? []), newTeam(previous ?? [], nextTempId)]);
    setNextTempId((id) => id - 1);
  }

  function removeTeam(team: AssignmentTeam) {
    setTeams((previous) => (previous ?? []).filter((t) => t.id !== team.id));
    setUnassigned((previous) => [...previous, ...team.members]);
  }

  function removeMember(teamId: number, member: string) {
    setTeams((previous) =>
      (previous ?? []).map((team) =>
        team.id === teamId
          ? { ...team, members: team.members.filter((m) => m !== member) }
          : team
      )
    );
    setUnassigned((previous) => [...previous, member]);
  }

  function assign(member: string, teamId: number) {
    setTeams((previous) =>
      (previous ?? []).map((team) =>
        team.id === teamId ? { ...team, members: [...team.members, member] } : team
      )
    );
    setUnassigned((previous) => previous.filter((m) => m !== member));
  }

  /** Répartit au hasard les étudiants sans équipe : remplit les équipes, puis en crée au besoin. */
  function assignRandomly() {
    const shuffled = [...unassigned]
      .map((member) => ({ member, order: Math.random() }))
      .sort((a, b) => a.order - b.order)
      .map(({ member }) => member);
    const next = (teams ?? []).map((team) => ({ ...team, members: [...team.members] }));
    let tempId = nextTempId;
    for (const member of shuffled) {
      let target = next.find((team) => team.members.length < maxSize);
      if (!target) {
        target = newTeam(next, tempId);
        tempId -= 1;
        next.push(target);
      }
      target.members.push(member);
    }
    setTeams(next);
    setUnassigned([]);
    setNextTempId(tempId);
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave(teams ?? []);
      popup.requestClose(onClose);
    } catch {
      setError("Les équipes n'ont pas pu être enregistrées. Réessayez.");
      setSaving(false);
    }
  }

  const openTeams = (teams ?? []).filter((team) => team.members.length < maxSize);

  return (
    <Popup
      variant={PopupVariant.FormWide}
      label="Gérer les équipes"
      onClose={onClose}
      controller={popup}
      panelStyle={WIDTH}
    >
      <div className={formStyles.form}>
        <header className={formStyles.header}>
          <div className={formStyles.headerText}>
            <h1>Gérer les équipes</h1>
            <p>
              {assignment.title} · {maxSize} membres au maximum
            </p>
          </div>
          <button
            type="button"
            className={formStyles.close}
            aria-label="Fermer"
            onClick={() => popup.requestClose(onClose)}
          >
            ✕
          </button>
        </header>

        <div className={formStyles.body}>
          <p className={formStyles.hint}>
            {assignment.teamFormation === 'students'
              ? 'Les étudiants forment leurs équipes eux-mêmes. Vous pouvez quand même les ajuster ici.'
              : 'Les étudiants verront leur équipe dès que vous aurez enregistré.'}
          </p>

          {!teams && !error && (
            <div className={styles.state} role="status" aria-busy="true">
              <Spinner size={24} />
            </div>
          )}

          {teams && (
            <>
              <div className={styles.teamActions}>
                <button type="button" className={formStyles.button} onClick={addTeam}>
                  Ajouter une équipe
                </button>
                <button
                  type="button"
                  className={formStyles.button}
                  disabled={unassigned.length === 0}
                  onClick={assignRandomly}
                >
                  Répartir au hasard
                </button>
              </div>

              <ul className={styles.teamGrid}>
                {teams.map((team) => (
                  <li key={team.id} className={styles.teamBox}>
                    <div className={styles.teamBoxHead}>
                      <strong>{team.name}</strong>
                      <TeamCount count={team.members.length} max={maxSize} />
                      <span className={styles.teamBoxSpacer} />
                      <button
                        type="button"
                        className={styles.teamRemove}
                        aria-label={`Retirer ${team.name}`}
                        onClick={() => removeTeam(team)}
                      >
                        ✕
                      </button>
                    </div>
                    {team.members.length === 0 ? (
                      <p className={styles.hint}>Aucun membre.</p>
                    ) : (
                      <ul className={styles.teamMembers}>
                        {team.members.map((member) => (
                          <li key={member}>
                            <span>{member}</span>
                            <button
                              type="button"
                              className={styles.teamRemove}
                              aria-label={`Retirer ${member} de ${team.name}`}
                              onClick={() => removeMember(team.id, member)}
                            >
                              ✕
                            </button>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                ))}
              </ul>

              <section aria-label="Étudiants sans équipe">
                <h2 className={styles.groupTitle}>Sans équipe ({unassigned.length})</h2>
                {unassigned.length === 0 ? (
                  <p className={styles.hint}>Tous les étudiants ont une équipe.</p>
                ) : (
                  <ul className={styles.teamUnassigned}>
                    {unassigned.map((member) => (
                      <li key={member}>
                        <span>{member}</span>
                        <select
                          aria-label={`Équipe de ${member}`}
                          value=""
                          disabled={openTeams.length === 0}
                          onChange={(event) => assign(member, Number(event.target.value))}
                        >
                          <option value="" disabled>
                            {openTeams.length === 0 ? 'Aucune place' : 'Ajouter à…'}
                          </option>
                          {openTeams.map((team) => (
                            <option key={team.id} value={team.id}>
                              {team.name}
                            </option>
                          ))}
                        </select>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </>
          )}

          {error && (
            <p className={formStyles.error} role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className={formStyles.footer}>
          <button
            type="button"
            className={formStyles.button}
            onClick={() => popup.requestClose(onClose)}
          >
            Annuler
          </button>
          <span className={formStyles.spacer} />
          <button
            type="button"
            className={`${formStyles.button} ${formStyles.primary}`}
            disabled={saving || !teams}
            onClick={() => void save()}
          >
            Enregistrer les équipes
          </button>
        </footer>
      </div>
    </Popup>
  );
}
