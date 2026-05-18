export function LogoMark({
  className,
  size = 24,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="4" y="4" width="56" height="56" rx="15" fill="currentColor" />
      <path
        d="M43.5 18.8A18.5 18.5 0 1 0 43.7 45"
        fill="none"
        stroke="var(--bg)"
        strokeWidth="6.6"
        strokeLinecap="round"
      />
      <path
        d="M43 19.5 32 32l11 12.5"
        fill="none"
        stroke="var(--surface-3)"
        strokeWidth="3.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <circle cx="43.5" cy="18.8" r="5.6" fill="var(--accent)" />
      <circle cx="32" cy="32" r="4.2" fill="var(--bg)" />
      <circle cx="43.7" cy="45" r="5.6" fill="var(--good)" />
    </svg>
  );
}
