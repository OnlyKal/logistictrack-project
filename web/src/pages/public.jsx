import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { Truck } from 'lucide-react'
import { api } from '../lib/api.js'
import { useAuth } from '../lib/auth.jsx'
import { Button, ErrorBox, Field, Input } from '../components/ui.jsx'
import { LoginScene } from '../components/LoginScene.jsx'

const Brand = () => <div className="brand" style={{ padding: 0, fontSize: 17 }}><span className="brand-mark"><Truck size={15} strokeWidth={2.2} aria-hidden /></span>LogisticTrack</div>

export function Login() {
  const { login } = useAuth()
  const navigate = useNavigate()
  const [identifier, setIdentifier] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await login(identifier, password)
      navigate('/')
    } catch (err) {
      setError(err)
      setBusy(false)
    }
  }
  return (
    <div className="login">
      <section className="login-scene">
        <LoginScene />
        <div className="login-top"><Brand /></div>
        <div className="login-copy">
          <h2>La logistique, en mouvement.</h2>
          <p>Stocks, commandes, livraisons et suivi des trajets, au même endroit.</p>
        </div>
      </section>
      <main className="login-side">
        <form className="stack login-form" onSubmit={submit}>
          <div><h1 className="page-title">Connexion</h1><p className="page-sub">Accédez à votre espace de gestion.</p></div>
          <ErrorBox error={error} />
          <Field label="E-mail ou téléphone"><Input required autoComplete="username" value={identifier} onChange={(e) => setIdentifier(e.target.value)} /></Field>
          <Field label="Mot de passe"><Input required type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
          <Button type="submit" variant="primary" size="lg" loading={busy}>Se connecter</Button>
          <div className="small login-links">
            <Link to="/mot-de-passe-oublie">Mot de passe oublié</Link>
            <Link to="/suivi-colis">Suivre un colis sans compte</Link>
          </div>
        </form>
      </main>
    </div>
  )
}

export function ForgotPassword() {
  // Le lien reçu par e-mail ouvre directement l'étape du nouveau mot de passe.
  const params = new URLSearchParams(window.location.search)
  const fromLink = params.get('token') ?? ''
  // Lien d'invitation : la personne choisit son premier mot de passe.
  const welcome = !!fromLink && params.get('bienvenue') === '1'
  const [identifier, setIdentifier] = useState('')
  const [token, setToken] = useState(fromLink)
  const [password, setPassword] = useState('')
  const [step, setStep] = useState(fromLink ? 'confirm' : 'ask')
  const [error, setError] = useState(null)
  const ask = async (e) => {
    e.preventDefault()
    setError(null)
    try {
      await api.post('/auth/password/reset', { identifier })
      setStep('confirm')
    } catch (err) { setError(err) }
  }
  const confirm = async (e) => {
    e.preventDefault()
    setError(null)
    try {
      await api.post('/auth/password/reset/confirm', { token, password })
      setStep('done')
    } catch (err) { setError(err) }
  }
  return (
    <div className="public">
      <Brand />
      <div className="card card-pad public-card">
        {step === 'ask' && (
          <form className="stack" onSubmit={ask}>
            <h1 className="page-title">Mot de passe oublié</h1>
            <ErrorBox error={error} />
            <p className="muted">Saisissez l'adresse e-mail de votre compte : vous recevrez un lien pour choisir un nouveau mot de passe. Les chauffeurs sans e-mail demandent à leur responsable.</p>
            <Field label="Adresse e-mail"><Input required type="email" autoComplete="email" value={identifier} onChange={(e) => setIdentifier(e.target.value)} /></Field>
            <Button type="submit" variant="primary" size="lg">Recevoir le lien</Button>
          </form>
        )}
        {step === 'confirm' && (
          <form className="stack" onSubmit={confirm}>
            <h1 className="page-title">{welcome ? 'Bienvenue' : 'Nouveau mot de passe'}</h1>
            <p className="muted">{welcome ? 'Choisissez le mot de passe de votre compte. Vous vous connecterez ensuite avec votre adresse e-mail.' : fromLink ? 'Choisissez votre nouveau mot de passe.' : "Si ce compte existe, un e-mail vient de vous être envoyé. Ouvrez le lien qu'il contient (pensez aux courriers indésirables)."}</p>
            <ErrorBox error={error} />
            {!fromLink && <Field label="Code reçu" hint="Seulement si vous ne pouvez pas ouvrir le lien."><Input value={token} onChange={(e) => setToken(e.target.value)} /></Field>}
            <Field label={welcome ? 'Mot de passe' : 'Nouveau mot de passe'} hint="8 caractères minimum."><Input required type="password" minLength={8} autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
            <Button type="submit" variant="primary" size="lg">{welcome ? 'Activer mon compte' : 'Enregistrer'}</Button>
          </form>
        )}
        {step === 'done' && <div className="stack"><h1 className="page-title">{welcome ? 'Compte activé' : 'Mot de passe modifié'}</h1><p className="muted">Vous pouvez maintenant vous connecter.</p><Link className="btn btn-primary" to="/connexion">Se connecter</Link></div>}
        <div className="small" style={{ marginTop: 14 }}><Link to="/connexion">Retour à la connexion</Link></div>
      </div>
    </div>
  )
}
