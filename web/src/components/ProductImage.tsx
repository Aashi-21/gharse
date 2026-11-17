import { useState } from 'react';

/** Product photo with a graceful placeholder when there is no image or the file cannot be loaded. */
export default function ProductImage({ src, alt, className = '' }: { src: string | null; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <div className={`flex items-center justify-center bg-cream-200 text-xs text-ink-faint ${className}`} role="img" aria-label={`No photo available for ${alt}`}>
        No photo
      </div>
    );
  }
  return <img src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} className={`object-cover ${className}`} />;
}
