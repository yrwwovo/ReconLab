import { cn } from '../../lib/utils'

export function Ripple({
  className,
  mainCircleSize = 210,
  mainCircleOpacity = 0.24,
  numCircles = 8,
}: {
  className?: string
  mainCircleSize?: number
  mainCircleOpacity?: number
  numCircles?: number
}) {
  return (
    <div className={cn('absolute inset-0 flex items-center justify-center overflow-hidden pointer-events-none', className)}>
      {Array.from({ length: numCircles }, (_, i) => {
        const size = mainCircleSize + i * 70
        const opacity = mainCircleOpacity - i * 0.03
        const delay = i * 0.06
        return (
          <div
            key={i}
            className="absolute rounded-full border animate-ripple"
            style={{
              width: `${size}px`,
              height: `${size}px`,
              opacity: Math.max(opacity, 0.02),
              borderColor: 'var(--primary, #2563eb)',
              animationDelay: `${delay}s`,
            }}
          />
        )
      })}
      <style>{`
        @keyframes ripple {
          0% { transform: scale(1); opacity: var(--opacity, 0.24); }
          100% { transform: scale(1.8); opacity: 0; }
        }
        .animate-ripple { animation: ripple 4s cubic-bezier(0.4, 0, 0.2, 1) infinite; }
      `}</style>
    </div>
  )
}
