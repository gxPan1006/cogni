export function LogoMark({
  className,
  size = 24,
}: {
  className?: string;
  size?: number;
}) {
  return (
    <img
      className={className}
      src="/cogni-logo.png"
      alt=""
      width={size}
      height={size}
      aria-hidden="true"
      draggable={false}
      style={{ width: size, height: size, objectFit: "contain" }}
    />
  );
}
