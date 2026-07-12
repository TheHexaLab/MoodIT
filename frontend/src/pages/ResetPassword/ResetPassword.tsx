import { useState, useEffect } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import '../LoginPage.css';
import { EyeIcon } from '../../assets/eye';
import { Lightanddark } from '../../assets/light-dark-btn';
import logo from '../../assets/Logo.png';
import { resetPassword, forgotPassword } from '../../helpers/api';
import { useTheme } from '../../helpers/theme';
import { CodeInput } from '../../components/CodeInput/CodeInput';

// Étape 2 du « mot de passe oublié » : saisie du code reçu par email + nouveau mot de passe.
// L'email provient de location.state (posé par ForgotPassword). En accès direct (state vide),
// on renvoie vers l'étape 1.
export default function ResetPassword() {
  const navigate = useNavigate();
  const location = useLocation();
  const { theme, toggleTheme } = useTheme();

  const email: string = location.state?.email || '';

  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirmPassword, setShowConfirmPassword] = useState(false);
  const [error, setError] = useState('');
  // Le champ « code » est-il en cause ? État explicite plutôt qu'une heuristique sur le
  // texte du message (fragile). Piloté aux points où l'on sait que l'erreur concerne le code.
  const [codeError, setCodeError] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState('');

  // Accès direct / rafraîchissement : sans email on ne peut rien réinitialiser.
  useEffect(() => {
    if (!email) navigate('/forgot-password', { replace: true });
  }, [email, navigate]);

  // Compte à rebours du renvoi (aligné sur le cooldown serveur de 60 s).
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  // Même barème que la page Register (0 = vide → 4 = fort).
  function passwordStrength(pw: string): 0 | 1 | 2 | 3 | 4 {
    if (pw.length === 0) return 0;
    if (pw.length < 8) return 1;
    const hasNumber = /[0-9]/.test(pw);
    const hasSpecial = /[!@#$%^&*()_+\-=[\]{};':"\\|,.<>/?]/.test(pw);
    if (hasNumber && hasSpecial) return 4;
    if (hasNumber || hasSpecial) return 3;
    return 2;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setCodeError(false);
    if (code.length !== 6) {
      setError('Le code doit contenir 6 chiffres');
      setCodeError(true);
      return;
    }
    if (!password) {
      setError('Le mot de passe est requis');
      return;
    }
    if (passwordStrength(password) < 2) {
      setError('Mot de passe trop faible');
      return;
    }
    if (confirmPassword !== password) {
      setError('Les mots de passe ne correspondent pas');
      return;
    }

    setSubmitting(true);
    try {
      await resetPassword(email, code, password);
      setSuccess(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de connexion au serveur');
      // Le serveur ne rejette que sur le code (invalide / expiré / verrouillé) : on surligne
      // le champ code, seul champ actionnable côté utilisateur.
      setCodeError(true);
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    if (cooldown > 0 || resending) return;
    setError('');
    setCodeError(false);
    setResendMsg('');
    setResending(true);
    try {
      await forgotPassword(email);
      setResendMsg('Si un compte existe, un nouveau code a été envoyé.');
      setCooldown(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de connexion au serveur');
    } finally {
      setResending(false);
    }
  }

  if (!email) return null;

  return (
    <div className="page">
      <aside className="aside">
        <div className="bubble-1" />
        <div className="bubble-2" />
        <div className="bubble-3" />
        <div className="aside-content">
          <div className="logo-wrapper">
            <img src={logo} alt="Logo MoodIT" />
          </div>
          <h1 className="app-name">MoodIT</h1>
          <p className="app-tagline">
            <span className={'app-tagline-text'}>Parce que Moodle,&nbsp;</span>
            <span className={'app-tagline-text'}>c'était pas assez chaotique.</span>
          </p>
        </div>
      </aside>

      <main className="main">
        <div className="form-card">
          {success ? (
            <>
              <h2 className="form-title">Mot de passe réinitialisé ✅</h2>
              <p className="form-subtitle">
                Vous pouvez maintenant vous connecter avec votre nouveau mot de passe.
              </p>
              <Link to="/login" className="btn-primary">
                Se connecter →
              </Link>
            </>
          ) : (
            <>
              <h2 className="form-title">Réinitialiser le mot de passe</h2>
              <p className="form-subtitle">
                Un code a été envoyé à votre email. Il expire dans 15 minutes.
              </p>

              <form className="form resetForm" onSubmit={handleSubmit}>
                {error && <p className="server-error">⚠ {error}</p>}

                <div className="field">
                  <label className="label">Code à 6 chiffres</label>
                  <CodeInput
                    value={code}
                    onChange={setCode}
                    disabled={submitting}
                    invalid={codeError}
                  />
                </div>

                <div className="field">
                  <div className="label-row">
                    <label className="label">Nouveau mot de passe</label>
                    {password && (
                      <span className="strength-label" data-level={passwordStrength(password)}>
                        {passwordStrength(password) === 1 && 'Mot de passe trop court'}
                        {passwordStrength(password) === 2 && 'Mot de passe faible'}
                        {passwordStrength(password) === 3 && 'Mot de passe moyen'}
                        {passwordStrength(password) === 4 && 'Mot de passe fort'}
                      </span>
                    )}
                  </div>
                  <div className="input-wrapper">
                    <input
                      className="input"
                      type={showPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder="••••••••••"
                      value={password}
                      maxLength={128}
                      onChange={(e) => setPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="eye-btn"
                      onClick={() => setShowPassword(!showPassword)}
                      aria-label={showPassword ? 'Masquer' : 'Afficher'}
                    >
                      <EyeIcon visible={showPassword} />
                    </button>
                  </div>
                  {password && (
                    <div className="strength" data-level={passwordStrength(password)}>
                      <span />
                      <span />
                      <span />
                      <span />
                    </div>
                  )}
                </div>

                <div className="field">
                  <div className="label-row">
                    <label className="label">Confirmer le mot de passe</label>
                    {confirmPassword && confirmPassword !== password && (
                      <span className="strength-label" data-level={1}>
                        Les mots de passe ne correspondent pas
                      </span>
                    )}
                  </div>
                  <div className="input-wrapper">
                    <input
                      className="input"
                      type={showConfirmPassword ? 'text' : 'password'}
                      autoComplete="new-password"
                      placeholder="••••••••••"
                      value={confirmPassword}
                      maxLength={128}
                      onChange={(e) => setConfirmPassword(e.target.value)}
                    />
                    <button
                      type="button"
                      className="eye-btn"
                      onClick={() => setShowConfirmPassword(!showConfirmPassword)}
                      aria-label={showConfirmPassword ? 'Masquer' : 'Afficher'}
                    >
                      <EyeIcon visible={showConfirmPassword} />
                    </button>
                  </div>
                </div>

                <button type="submit" className="btn-primary" disabled={submitting}>
                  {submitting ? 'Réinitialisation...' : 'Réinitialiser →'}
                </button>

                {resendMsg && <p className="form-subtitle">{resendMsg}</p>}
                <p className="register-row">
                  Pas reçu le code ?{' '}
                  <button
                    type="button"
                    className="register-link"
                    onClick={handleResend}
                    disabled={cooldown > 0 || resending}
                    style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 0 }}
                  >
                    {cooldown > 0 ? `Renvoyer (${cooldown}s)` : resending ? 'Envoi...' : 'Renvoyer'}
                  </button>
                </p>
                <p className="register-row">
                  <Link to="/login" className="register-link">
                    ← Retour à la connexion
                  </Link>
                </p>
              </form>
            </>
          )}
        </div>

        <footer className="footer">© 2026 MoodIT · Confidentialité · Conditions d'utilisation</footer>
      </main>
      <button type="button" className="light-dark-btn" onClick={toggleTheme}>
        <Lightanddark isDark={theme === 'dark'} />
      </button>
    </div>
  );
}
