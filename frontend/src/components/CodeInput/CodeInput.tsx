import { useRef } from 'react';
import styles from './CodeInput.module.css';

interface CodeInputProps {
  /** Code courant (chaîne de chiffres, longueur ≤ length). */
  value: string;
  /** Appelé avec le nouveau code (chiffres uniquement). */
  onChange: (code: string) => void;
  /** Nombre de cases (défaut 6). */
  length?: number;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Bordure d'erreur (ex. code invalide). */
  invalid?: boolean;
  ariaLabel?: string;
}

/**
 * Champ de code segmenté (une case par chiffre) : saisie chiffre → avance, retour arrière →
 * efface et recule, flèches ←/→ pour naviguer, collage réparti sur les cases. Le composant est
 * contrôlé : l'état réel est la chaîne `value`, chaque case en dérive son chiffre.
 */
export function CodeInput({
  value,
  onChange,
  length = 6,
  autoFocus,
  disabled,
  invalid,
  ariaLabel = 'Code à 6 chiffres',
}: CodeInputProps): React.ReactElement {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const digits = Array.from({ length }, (_, i) => value[i] ?? '');

  const emit = (next: string[]) => onChange(next.join('').slice(0, length));

  const handleChange = (index: number, raw: string) => {
    const clean = raw.replace(/\D/g, '');
    if (clean.length === 0) {
      const next = digits.slice();
      next[index] = '';
      emit(next);
      return;
    }
    // Collage / autofill : plusieurs chiffres arrivent d'un coup. Quelle que soit la case où ils
    // atterrissent, on remplit TOUT le code depuis le DÉBUT (comme un vrai champ OTP), et non à
    // partir de la case courante. Couvre le collage mobile (l'évènement `paste` ne se déclenche
    // souvent pas → tout passe par ce `onChange`).
    if (clean.length > 1) {
      const code = clean.slice(0, length);
      onChange(code);
      refs.current[Math.min(code.length, length - 1)]?.focus();
      return;
    }
    // Un seul chiffre : saisie normale → on le place dans la case courante et on avance.
    const next = digits.slice();
    next[index] = clean;
    emit(next);
    if (index < length - 1) refs.current[index + 1]?.focus();
  };

  const handleKeyDown = (index: number, e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      const next = digits.slice();
      if (digits[index]) {
        next[index] = '';
        emit(next);
      } else if (index > 0) {
        next[index - 1] = '';
        emit(next);
        refs.current[index - 1]?.focus();
      }
    } else if (e.key === 'ArrowLeft' && index > 0) {
      refs.current[index - 1]?.focus();
    } else if (e.key === 'ArrowRight' && index < length - 1) {
      refs.current[index + 1]?.focus();
    }
  };

  const handlePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const pasted = e.clipboardData.getData('text').replace(/\D/g, '').slice(0, length);
    if (!pasted) return;
    onChange(pasted);
    refs.current[Math.min(pasted.length, length - 1)]?.focus();
  };

  return (
    <div className={styles.wrapper} role="group" aria-label={ariaLabel}>
      {digits.map((digit, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className={`${styles.box}${invalid ? ' ' + styles.invalid : ''}`}
          type="text"
          inputMode="numeric"
          autoComplete={i === 0 ? 'one-time-code' : 'off'}
          // PAS maxLength=1 : sur mobile l'évènement `paste` ne se déclenche souvent pas, et
          // maxLength=1 tronquerait le collage à un seul chiffre AVANT `onChange`. En laissant
          // passer toute la chaîne, `handleChange` la répartit sur les cases (comme l'autofill).
          // La saisie normale reste à 1 chiffre : le focus avance à chaque frappe + `onFocus`
          // sélectionne le contenu (une nouvelle frappe le remplace).
          maxLength={length}
          value={digit}
          disabled={disabled}
          autoFocus={autoFocus && i === 0}
          data-filled={digit ? 'true' : 'false'}
          onChange={(e) => handleChange(i, e.target.value)}
          onKeyDown={(e) => handleKeyDown(i, e)}
          onPaste={handlePaste}
          onFocus={(e) => e.currentTarget.select()}
          aria-label={`Chiffre ${i + 1}`}
        />
      ))}
    </div>
  );
}
