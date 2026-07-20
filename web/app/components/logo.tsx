// components/Logo.tsx
import Image from "next/image";

export function LogoMark({ size = 42, className = "" }: { size?: number; className?: string }) {
  return (
    <>
      <Image
        src="/icons/postersup-icon.svg"
        alt="Posters Up Logo"
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={`hidden dark:inline-block align-middle ${className}`}
      />
      <Image
        src="/icons/postersup-icon-light.svg"
        alt="Posters Up Logo"
        aria-hidden="true"
        width={size}
        height={size}
        style={{ width: size, height: size }}
        className={`inline-block dark:hidden align-middle ${className}`}
      />
    </>
  );
}