import { useEffect, useRef } from 'react'
import { cn } from '../../lib/utils'

export function GlowingStars({
  className,
  count = 40,
}: {
  className?: string
  count?: number
}) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    container.innerHTML = ''

    for (let i = 0; i < count; i++) {
      const star = document.createElement('div')
      const size = Math.random() * 3 + 1
      star.style.cssText = `
        position: absolute;
        width: ${size}px;
        height: ${size}px;
        left: ${Math.random() * 100}%;
        top: ${Math.random() * 100}%;
        background: white;
        border-radius: 50%;
        opacity: 0;
        animation: glow-star ${2 + Math.random() * 3}s ${Math.random() * 3}s ease-in-out infinite;
      `
      container.appendChild(star)
    }
  }, [count])

  return (
    <>
      <div ref={containerRef} className={cn('absolute inset-0 overflow-hidden pointer-events-none', className)} />
      <style>{`
        @keyframes glow-star {
          0%, 100% { opacity: 0; transform: scale(0.5); box-shadow: 0 0 0 0 rgba(255,255,255,0); }
          50% { opacity: 0.8; transform: scale(1); box-shadow: 0 0 8px 2px rgba(255,255,255,0.3); }
        }
      `}</style>
    </>
  )
}
