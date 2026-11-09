/**
 * Logo de l'application LogisticTrack : carré bleu, « LT » blanc.
 * Même dessin que le favicon (public/favicon.svg) et que l'icône de l'application mobile.
 * Les documents d'une entreprise (PDF, e-mails, suivi client) portent le logo de cette entreprise.
 */
export function LogoMark({ size = 26, className = '' }) {
  return (
    <svg className={`logo-mark ${className}`} width={size} height={size} viewBox="0 0 32 32" aria-hidden focusable="false">
      <rect width="32" height="32" rx="8" fill="#2563EB" />
      <path d="M10 8v14h12" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M15 8h9M19.5 8v9" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" />
    </svg>
  )
}
