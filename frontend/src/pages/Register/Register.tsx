import styles from './Register.module.css';
import { useTheme } from '../../helpers/theme';
import { useState } from 'react';
import { register } from '../../helpers/api';
import { Lightanddark } from '../../assets/light-dark-btn';
import { EyeIcon } from '../../assets/eye';
import logo from '../../assets/Logo.png';
import { Link, useNavigate } from 'react-router-dom';
import { classifyServerError, publicServerError } from '../../helpers/serverError';

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type FieldErrors = {
  username?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  password?: string;
  confirmPassword?: string;
  terms?: string;
};

export default function Register() {
  const { theme, toggleTheme } = useTheme();
  const [username, setUsername] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [acceptTerms, setAcceptTerms] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [serverError, setServerError] = useState('');
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const navigate = useNavigate();

  function passwordStrength(pw: string): 0 | 1 | 2 | 3 | 4 {
    if (pw.length === 0) return 0;
    if (pw.length < 8) return 1;
    const hasNumber = /[0-9]/.test(pw);
    const hasSpecial = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(pw);
    if (hasNumber && hasSpecial) return 4;
    if (hasNumber || hasSpecial) return 3;
    return 2;
  }

  // Associe un message d'erreur serveur au bon champ (logique de mapping mutualisée).
  function mapServerError(message: string) {
    const field = classifyServerError(message);
    if (field === 'username') {
      setFieldErrors({ username: message });
    } else if (field === 'email') {
      setFieldErrors({ email: message });
    } else if (field === 'password') {
      setFieldErrors({ password: message });
    } else {
      setServerError(publicServerError(message));
    }
  }

  async function handleSubmit() {
    setServerError('');
    setFieldErrors({});

    const errors: FieldErrors = {};
    if (!username) errors.username = 'Requis';
    if (!firstName) errors.firstName = 'Requis';
    if (!lastName) errors.lastName = 'Requis';
    if (!email) errors.email = 'Requis';
    else if (!EMAIL_REGEX.test(email)) errors.email = 'Format d’e-mail invalide';
    if (!password) errors.password = 'Requis';
    else if (passwordStrength(password) < 2) errors.password = 'Mot de passe trop faible';
    if (!confirmPassword) errors.confirmPassword = 'Requis';
    else if (confirmPassword !== password)
      errors.confirmPassword = 'Les mots de passe ne correspondent pas';
    if (!acceptTerms) errors.terms = "Vous devez accepter les conditions d'utilisation";

    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }

    setSubmitting(true);
    try {
      await register({
        username,
        firstName,
        lastName,
        email,
        password,
      });
      navigate('/verify-code', { state: { email, mode: 'email' } });
    } catch (err) {
      mapServerError(err instanceof Error ? err.message : 'Erreur inconnue');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className={styles.page}>
      <aside className={styles.brand}>
        <div className={styles.bubble1} />
        <div className={styles.bubble2} />
        <div className={styles.bubble3} />
        <div className={styles.brandInner}>
          <div className={styles.logoWrapper}>
            <img src={logo} alt="Logo MoodIT" />
          </div>
          <h1 className={styles.brandTitle}>MoodIT</h1>
          <p className={styles.brandTagline}>Parce que Moodle, c'était pas assez chaotique.</p>
        </div>
      </aside>

      <main className={styles.formSide}>
        <div className={styles.card}>
              <header className={styles.cardHeader}>
                <h2>Créer un compte</h2>
                <p>Rejoignez votre espace MoodIT</p>
              </header>

              {serverError && <p className={styles.serverError}>⚠ {serverError}</p>}

              <div className={styles.field}>
                <div className={styles.labelRow}>
                  <label className={styles.label}>Nom d'utilisateur</label>
                  {fieldErrors.username && (
                    <span className={styles.error}>⚠ {fieldErrors.username}</span>
                  )}
                </div>
                <div
                  className={`${styles.inputWrap}${fieldErrors.username ? ' ' + styles.invalid : ''}`}
                >
                  <input
                    type="text"
                    autoComplete="username"
                    value={username}
                    placeholder="ex : RKarine"
                    onChange={(e) => setUsername(e.target.value)}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <div className={styles.labelRow}>
                  <label className={styles.label}>Prénom</label>
                  {fieldErrors.firstName && (
                    <span className={styles.error}>⚠ {fieldErrors.firstName}</span>
                  )}
                </div>
                <div
                  className={`${styles.inputWrap}${fieldErrors.firstName ? ' ' + styles.invalid : ''}`}
                >
                  <input
                    type="text"
                    autoComplete="given-name"
                    value={firstName}
                    placeholder="ex: Karine"
                    onChange={(e) => setFirstName(e.target.value)}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <div className={styles.labelRow}>
                  <label className={styles.label}>Nom</label>
                  {fieldErrors.lastName && (
                    <span className={styles.error}>⚠ {fieldErrors.lastName}</span>
                  )}
                </div>
                <div
                  className={`${styles.inputWrap}${fieldErrors.lastName ? ' ' + styles.invalid : ''}`}
                >
                  <input
                    type="text"
                    autoComplete="family-name"
                    value={lastName}
                    placeholder="ex: Roussel"
                    onChange={(e) => setLastName(e.target.value)}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <div className={styles.labelRow}>
                  <label className={styles.label}>Adresse email</label>
                  {fieldErrors.email && (
                    <span className={styles.error}>⚠ {fieldErrors.email}</span>
                  )}
                </div>
                <div
                  className={`${styles.inputWrap}${fieldErrors.email ? ' ' + styles.invalid : ''}`}
                >
                  <input
                    type="email"
                    autoComplete="email"
                    value={email}
                    placeholder="ex: Karine_Roussel@usherbrooke.ca"
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </div>
              </div>

              <div className={styles.field}>
                <div className={styles.labelRow}>
                  <label className={styles.label}>Mot de passe</label>
                  {fieldErrors.password ? (
                    <span className={styles.error}>⚠ {fieldErrors.password}</span>
                  ) : (
                    password && (
                      <span className={styles.strengthLabel} data-level={passwordStrength(password)}>
                        {passwordStrength(password) === 1 && 'Mot de passe trop court'}
                        {passwordStrength(password) === 2 && 'Mot de passe faible'}
                        {passwordStrength(password) === 3 && 'Mot de passe moyen'}
                        {passwordStrength(password) === 4 && 'Mot de passe fort'}
                      </span>
                    )
                  )}
                </div>
                <div
                  className={`${styles.inputWrap}${fieldErrors.password ? ' ' + styles.invalid : ''}`}
                >
                  <input
                    type={showPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={password}
                    placeholder="Choisissez un mot de passe"
                    onChange={(e) => setPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.eyeBtn}
                    onClick={() => setShowPassword(!showPassword)}
                    aria-label={showPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'}
                  >
                    <EyeIcon visible={showPassword} />
                  </button>
                </div>
                {password && (
                  <div className={styles.strength} data-level={passwordStrength(password)}>
                    <span />
                    <span />
                    <span />
                    <span />
                  </div>
                )}
              </div>

              <div className={styles.field}>
                <div className={styles.labelRow}>
                  <label className={styles.label}>Confirmer le mot de passe</label>
                  {fieldErrors.confirmPassword ? (
                    <span className={styles.error}>⚠ {fieldErrors.confirmPassword}</span>
                  ) : (
                    confirmPassword &&
                    confirmPassword !== password && (
                      <span className={styles.error}>⚠ Les mots de passe ne correspondent pas</span>
                    )
                  )}
                </div>
                <div
                  className={`${styles.inputWrap}${
                    fieldErrors.confirmPassword || (confirmPassword && confirmPassword !== password)
                      ? ' ' + styles.invalid
                      : ''
                  }`}
                >
                  <input
                    type={showConfirmPassword ? 'text' : 'password'}
                    autoComplete="new-password"
                    value={confirmPassword}
                    placeholder="Retapez votre mot de passe"
                    onChange={(e) => setConfirmPassword(e.target.value)}
                  />
                  <button
                    type="button"
                    className={styles.eyeBtn}
                    onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                    aria-label={
                      showConfirmPassword ? 'Masquer le mot de passe' : 'Afficher le mot de passe'
                    }
                  >
                    <EyeIcon visible={showConfirmPassword} />
                  </button>
                </div>
              </div>

              <label className={styles.terms}>
                <input
                  type="checkbox"
                  checked={acceptTerms}
                  onChange={(e) => setAcceptTerms(e.target.checked)}
                />
                <span>
                  J'accepte les{' '}
                  <a
                    href="https://www.youtube.com/watch?v=Aq5WXmQQooo"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    conditions d'utilisation
                  </a>{' '}
                  et la{' '}
                  <a
                    href="https://www.youtube.com/watch?v=Aq5WXmQQooo"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    politique de confidentialité
                  </a>
                </span>
              </label>
              {fieldErrors.terms && <p className={styles.error}>⚠ {fieldErrors.terms}</p>}

              <button
                type="button"
                className={styles.submit}
                onClick={handleSubmit}
                disabled={submitting}
              >
                {submitting ? 'Création...' : 'Créer mon compte →'}
              </button>

              <div className={styles.divider}>
                <span>ou</span>
              </div>

              <p className={styles.loginLink}>
                Déjà un compte ? <Link to="/login">Se connecter</Link>
              </p>
        </div>

        <footer className={styles.pageFooter}>
          © 2026 MoodIT ·{' '}
          <a
            href="https://www.youtube.com/watch?v=Aq5WXmQQooo"
            target="_blank"
            rel="noopener noreferrer"
          >
            Confidentialité
          </a>{' '}
          ·{' '}
          <a
            href="https://www.youtube.com/watch?v=Aq5WXmQQooo"
            target="_blank"
            rel="noopener noreferrer"
          >
            Conditions d'utilisation
          </a>
        </footer>
      </main>
      <button
        type="button"
        className="light-dark-btn"
        onClick={toggleTheme}
        aria-label="Changer de thème"
      >
        <Lightanddark isDark={theme === 'dark'} />
      </button>
    </div>
  );
}
