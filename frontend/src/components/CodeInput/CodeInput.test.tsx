import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useState } from 'react';
import { CodeInput } from './CodeInput';

/**
 * Tests du champ de code segmenté (une case par chiffre). Le composant est contrôlé : on le
 * monte soit avec un `onChange` espion (valeur figée), soit dans un petit hôte à état pour
 * observer l'enchaînement réel (saisie → avance du focus, retour arrière → recul, collage).
 */

afterEach(() => {
  cleanup();
});

/** Hôte à état : reproduit l'usage réel (value ← onChange) et expose la valeur courante. */
function Host({ initial = '', onChange }: { initial?: string; onChange?: (c: string) => void }) {
  const [code, setCode] = useState(initial);
  return (
    <>
      <CodeInput
        value={code}
        onChange={(c) => {
          setCode(c);
          onChange?.(c);
        }}
      />
      <output data-testid="value">{code}</output>
    </>
  );
}

function boxes(): HTMLInputElement[] {
  return Array.from({ length: 6 }, (_, i) => screen.getByLabelText(`Chiffre ${i + 1}`)) as
    HTMLInputElement[];
}

function currentValue(): string {
  return screen.getByTestId('value').textContent ?? '';
}

/**
 * Déclenche un collage avec le texte donné sur la case `el`. Le presse-papiers ne répond qu'au
 * format `text` (comme un navigateur), et renvoie `false` si le collage par défaut est annulé.
 */
function paste(el: HTMLElement, text: string): boolean {
  return fireEvent.paste(el, {
    clipboardData: { getData: (format: string) => (format === 'text' ? text : '') },
  });
}

describe('CodeInput', () => {
  it('rend 6 cases par défaut, dans un groupe étiqueté', () => {
    render(<CodeInput value="" onChange={vi.fn()} />);
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe('Code à 6 chiffres');
    expect(screen.getAllByRole('textbox')).toHaveLength(6);
  });

  it('respecte la longueur et l’étiquette personnalisées', () => {
    render(<CodeInput value="" onChange={vi.fn()} length={4} ariaLabel="PIN" />);
    expect(screen.getByRole('group').getAttribute('aria-label')).toBe('PIN');
    expect(screen.getAllByRole('textbox')).toHaveLength(4);
  });

  it('répartit la valeur sur les cases et marque les cases remplies', () => {
    render(<CodeInput value="12" onChange={vi.fn()} />);
    const b = boxes();
    expect(b.map((x) => x.value)).toEqual(['1', '2', '', '', '', '']);
    expect(b[0].getAttribute('data-filled')).toBe('true');
    expect(b[2].getAttribute('data-filled')).toBe('false');
  });

  it('seule la 1re case porte autocomplete="one-time-code"', () => {
    render(<CodeInput value="" onChange={vi.fn()} />);
    const b = boxes();
    expect(b[0].getAttribute('autocomplete')).toBe('one-time-code');
    expect(b[1].getAttribute('autocomplete')).toBe('off');
  });

  it('autoFocus place le focus sur la 1re case', () => {
    render(<CodeInput value="" onChange={vi.fn()} autoFocus />);
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it('disabled désactive toutes les cases', () => {
    render(<CodeInput value="" onChange={vi.fn()} disabled />);
    expect(boxes().every((b) => b.disabled)).toBe(true);
  });

  it('invalid ajoute une classe d’erreur à chaque case', () => {
    const { rerender } = render(<CodeInput value="" onChange={vi.fn()} />);
    const before = boxes()[0].className;
    rerender(<CodeInput value="" onChange={vi.fn()} invalid />);
    const after = boxes()[0].className;
    expect(after).not.toBe(before);
    expect(after.split(' ').length).toBe(before.split(' ').length + 1);
  });

  it('saisir un chiffre l’émet et avance le focus à la case suivante', () => {
    render(<Host />);
    fireEvent.change(boxes()[0], { target: { value: '4' } });
    expect(currentValue()).toBe('4');
    expect(document.activeElement).toBe(boxes()[1]);
  });

  it('ignore les caractères non numériques', () => {
    const onChange = vi.fn();
    render(<CodeInput value="" onChange={onChange} />);
    fireEvent.change(boxes()[0], { target: { value: 'a' } });
    // Aucun chiffre : la case est vidée (émission d'une chaîne vide), pas de lettre transmise.
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('saisie rapide / autofill : plusieurs chiffres d’un coup sont répartis', () => {
    render(<Host />);
    fireEvent.change(boxes()[0], { target: { value: '789' } });
    expect(boxes().map((b) => b.value)).toEqual(['7', '8', '9', '', '', '']);
    expect(document.activeElement).toBe(boxes()[3]);
  });

  // Garde : la valeur est une chaîne compacte (join('')), donc un chiffre saisi dans une case
  // précédée de cases vides « glisse » vers la 1re case ; le focus doit suivre ce chiffre
  // (case 2) et non avancer depuis la case cliquée (case 5).
  it('saisie après des cases vides : le focus suit la case où le chiffre s’affiche', () => {
    render(<Host />);
    fireEvent.change(boxes()[3], { target: { value: '5' } });
    expect(boxes()[0].value).toBe('5');
    expect(document.activeElement).toBe(boxes()[1]);
  });

  it('autofill qui déborde : tronqué à la longueur, focus sur la dernière case', () => {
    render(<Host />);
    fireEvent.change(boxes()[0], { target: { value: '123456789' } });
    expect(currentValue()).toBe('123456');
    expect(document.activeElement).toBe(boxes()[5]);
  });

  it('retour arrière sur une case remplie l’efface sans reculer', () => {
    render(<Host initial="123" />);
    const b = boxes();
    b[2].focus();
    fireEvent.keyDown(b[2], { key: 'Backspace' });
    expect(currentValue()).toBe('12');
    expect(document.activeElement).toBe(b[2]);
  });

  it('retour arrière sur une case vide efface la précédente et y recule', () => {
    render(<Host initial="12" />);
    const b = boxes();
    b[2].focus();
    fireEvent.keyDown(b[2], { key: 'Backspace' });
    expect(currentValue()).toBe('1');
    expect(document.activeElement).toBe(b[1]);
  });

  it('retour arrière sur la 1re case vide ne fait rien', () => {
    const onChange = vi.fn();
    render(<CodeInput value="" onChange={onChange} />);
    fireEvent.keyDown(boxes()[0], { key: 'Backspace' });
    expect(onChange).not.toHaveBeenCalled();
  });

  it('flèches ←/→ déplacent le focus, sans sortir des bornes', () => {
    render(<CodeInput value="" onChange={vi.fn()} />);
    const b = boxes();
    b[2].focus();
    fireEvent.keyDown(b[2], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(b[1]);
    fireEvent.keyDown(b[1], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(b[2]);

    b[0].focus();
    fireEvent.keyDown(b[0], { key: 'ArrowLeft' });
    expect(document.activeElement).toBe(b[0]);
    b[5].focus();
    fireEvent.keyDown(b[5], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(b[5]);
  });

  it('collage : ne garde que les chiffres, tronque à 6 et place le focus en fin', () => {
    render(<Host />);
    paste(boxes()[0], ' 12-34 56 78');
    expect(currentValue()).toBe('123456');
    expect(document.activeElement).toBe(boxes()[5]);
  });

  it('collage partiel : focus sur la case qui suit le dernier chiffre collé', () => {
    render(<Host />);
    paste(boxes()[0], '12');
    expect(currentValue()).toBe('12');
    expect(document.activeElement).toBe(boxes()[2]);
  });

  it('collage sans chiffre : ignoré', () => {
    const onChange = vi.fn();
    render(<CodeInput value="" onChange={onChange} />);
    paste(boxes()[0], 'abc');
    expect(onChange).not.toHaveBeenCalled();
  });
  it('caractère non numérique sur une case remplie : seule cette case est vidée, focus inchangé', () => {
    render(<Host initial="123" />);
    const b = boxes();
    b[1].focus();
    fireEvent.change(b[1], { target: { value: 'x' } });
    expect(currentValue()).toBe('13');
    expect(document.activeElement).toBe(b[1]);
  });

  it('saisie multiple depuis une case du milieu : remplace tout le code depuis le début (comme le collage)', () => {
    render(<Host initial="12" />);
    fireEvent.change(boxes()[2], { target: { value: '345' } });
    expect(currentValue()).toBe('345');
    expect(document.activeElement).toBe(boxes()[3]);
  });

  it('saisie multiple près de la fin : le code saisi remplace tout, depuis la 1re case', () => {
    const onChange = vi.fn();
    render(<CodeInput value="1234" onChange={onChange} />);
    fireEvent.change(boxes()[4], { target: { value: '9876' } });
    expect(onChange).toHaveBeenLastCalledWith('9876');
    expect(document.activeElement).toBe(boxes()[4]);
  });

  it('la valeur émise ne dépasse jamais la longueur, même avec une longueur réduite', () => {
    const onChange = vi.fn();
    render(<CodeInput value="12" onChange={onChange} length={4} />);
    fireEvent.change(screen.getByLabelText('Chiffre 2'), { target: { value: '99999' } });
    expect(onChange).toHaveBeenLastCalledWith('9999');
    expect(document.activeElement).toBe(screen.getByLabelText('Chiffre 4'));
  });

  it('chaque case accepte tout le code (maxLength = longueur) : le collage mobile n’est pas tronqué', () => {
    render(<CodeInput value="" onChange={() => {}} length={4} />);
    for (const box of screen.getAllByRole('textbox')) expect((box as HTMLInputElement).maxLength).toBe(4);
  });

  it('collage depuis une case du milieu : remplace tout le code depuis le début', () => {
    render(<Host initial="999" />);
    paste(boxes()[3], '123');
    expect(currentValue()).toBe('123');
    expect(document.activeElement).toBe(boxes()[3]);
  });

  it('collage avec une longueur réduite : tronqué, focus sur la dernière case', () => {
    const onChange = vi.fn();
    render(<CodeInput value="" onChange={onChange} length={4} />);
    paste(screen.getByLabelText('Chiffre 1'), '123456');
    expect(onChange).toHaveBeenCalledWith('1234');
    expect(document.activeElement).toBe(screen.getByLabelText('Chiffre 4'));
  });

  it('retour arrière sur une case vide au milieu recule même si la précédente est vide', () => {
    const onChange = vi.fn();
    render(<CodeInput value="1" onChange={onChange} />);
    const b = boxes();
    b[3].focus();
    fireEvent.keyDown(b[3], { key: 'Backspace' });
    expect(document.activeElement).toBe(b[2]);
    expect(onChange).toHaveBeenCalledWith('1');
  });

  it('les flèches ne modifient pas la valeur et une autre touche ne déplace pas le focus', () => {
    const onChange = vi.fn();
    render(<CodeInput value="12" onChange={onChange} />);
    const b = boxes();
    b[1].focus();
    fireEvent.keyDown(b[1], { key: 'ArrowRight' });
    expect(document.activeElement).toBe(b[2]);
    fireEvent.keyDown(b[2], { key: 'Enter' });
    expect(document.activeElement).toBe(b[2]);
    expect(onChange).not.toHaveBeenCalled();
  });

  it('prendre le focus sélectionne le chiffre de la case (la saisie le remplace)', () => {
    render(<CodeInput value="5" onChange={vi.fn()} />);
    const first = boxes()[0];
    first.setSelectionRange(1, 1);
    fireEvent.focus(first);
    expect(first.selectionStart).toBe(0);
    expect(first.selectionEnd).toBe(1);
  });

  it('le collage remplace le comportement du navigateur (pas d’insertion brute dans la case)', () => {
    render(<Host />);
    // fireEvent renvoie false quand le gestionnaire appelle preventDefault().
    expect(paste(boxes()[0], '123456')).toBe(false);
    expect(currentValue()).toBe('123456');
  });
});
