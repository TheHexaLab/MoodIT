import React from 'react';
import styles from './DeleteConfirmationBox.module.css';

type DeleteConfirmationBoxProps = {
  title: string;
  content: string;
  onDeleteConfirmation: (...args: unknown[]) => unknown;
  onClose: (...args: unknown[]) => unknown;
};

export function DeleteConfirmationBox(props: DeleteConfirmationBoxProps): React.ReactElement {
  return (
    <div className={styles['confirmation-box']}>
      <div>
        <div>
          <h1>{props.title}</h1>
          <p>{props.content}</p>
        </div>
        <div>
          <button onClick={props.onClose}>Annuler</button>
          <button onClick={props.onDeleteConfirmation}>Supprimer</button>
        </div>
      </div>
    </div>
  );
}
