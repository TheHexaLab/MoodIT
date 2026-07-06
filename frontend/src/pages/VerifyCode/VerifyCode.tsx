import { useState, useEffect } from 'react';
import { useLocation, useNavigate, Link } from 'react-router-dom';
import '../LoginPage.css';
import { useTheme } from '../../helpers/theme';
import { verifyEmail, verify2FA, resendCode } from '../../helpers/api';
import { Lightanddark } from '../../assets/light-dark-btn';
import logo from '../../assets/Logo.png';

type Mode = 'email' | '2fa';

export default function VerifyCode() {
  const { theme, toggleTheme } = useTheme();
  const navigate = useNavigate();
  const location = useLocation();

  const email: string = location.state?.email || '';
  const mode: Mode = location.state?.mode || 'email';

  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);
  const [cooldown, setCooldown] = useState(0);
  const [resending, setResending] = useState(false);
  const [resendMsg, setResendMsg] = useState('');

  const isEmailVerification = mode === 'email';

  // Accès direct / rafraîchissement : location.state est null, donc email est vide. On ne peut
  // rien vérifier sans email -> on renvoie vers le login plutôt que d'envoyer une requête vide.
  useEffect(() => {
    if (!email) {
      navigate('/login', { replace: true });
    }
  }, [email, navigate]);

  // Compte à rebours du cooldown de renvoi (aligné sur le délai serveur de 60 s).
  useEffect(() => {
    if (cooldown <= 0) return;
    const id = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(id);
  }, [cooldown]);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');

    if (code.length !== 6) {
      setError('Le code doit contenir 6 chiffres');
      return;
    }

    setSubmitting(true);
    try {
      if (isEmailVerification) {
        await verifyEmail(email, code);
        setSuccess(true);
      } else {
        // 2FA — l'auth-service pose le cookie HttpOnly `moodit_token` dans la réponse
        // (credentials:'include'). Rien à stocker côté JS : on redirige.
        await verify2FA(email, code);
        navigate('/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de connexion au serveur');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleResend() {
    if (cooldown > 0 || resending) return;
    setError('');
    setResendMsg('');
    setResending(true);
    try {
      await resendCode(email, mode);
      setResendMsg('Un nouveau code a été envoyé.');
      setCooldown(60);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Erreur de connexion au serveur');
    } finally {
      setResending(false);
    }
  }

  // Évite d'afficher un instant le formulaire cassé (email vide) avant que la redirection
  // ci-dessus ne s'applique.
  if (!email) {
    return null;
  }

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
              <h2 className="form-title">Email vérifié ✅</h2>
              <p className="form-subtitle">Votre compte est maintenant actif.</p>
              <Link to="/login" className="btn-primary">
                Se connecter →
              </Link>
            </>
          ) : (
            <>
              <h2 className="form-title">
                {isEmailVerification ? 'Vérifiez votre email 📧' : 'Double authentification 🔒'}
              </h2>
              <p className="form-subtitle">
                Un code a été envoyé à <strong>{email}</strong>. Il expire dans 15 minutes.
              </p>

              <form className="form" onSubmit={handleSubmit}>
                {error && <p className="server-error">⚠ {error}</p>}

                <div className="field">
                  <label className="label">Code à 6 chiffres</label>
                  <input
                    className="input"
                    type="text"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    value={code}
                    maxLength={6}
                    placeholder="123456"
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  />
                </div>

                <button type="submit" className="btn-primary" disabled={submitting}>
                  {submitting ? 'Vérification...' : 'Vérifier →'}
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
                    {cooldown > 0
                      ? `Renvoyer (${cooldown}s)`
                      : resending
                        ? 'Envoi...'
                        : 'Renvoyer le code'}
                  </button>
                </p>
                <p className="register-row">
                  <Link to={isEmailVerification ? '/register' : '/login'} className="register-link">
                    ← Retour
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
