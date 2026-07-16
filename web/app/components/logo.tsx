// components/Logo.tsx
import Image from "next/image";

export function LogoMark({ className = "" }: { className?: string }) {
  return (
    <>
      <Image
        src="/icons/postersup-icon.svg"
        alt="Posters Up Logo"
        width={42}
        height={42}
        className={`hidden dark:block ${className}`}
      />
      <Image
        src="/icons/postersup-icon-light.svg"
        alt="Posters Up Logo"
        aria-hidden="true"
        width={42}
        height={42}
        className={`block dark:hidden ${className}`}
      />
    </>
  );
}