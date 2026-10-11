import { useRef } from 'react'
import { motion, useAnimationFrame } from 'framer-motion'

interface MovingBorderProps {
  children: React.ReactNode
  duration?: number
  className?: string
  containerClassName?: string
  borderClassName?: string
}

export function MovingBorder({
  children,
  duration = 3000,
  className = '',
  containerClassName = '',
  borderClassName = '',
}: MovingBorderProps) {
  const progressRef = useRef(0)
  const circleRef = useRef<HTMLDivElement>(null)

  useAnimationFrame((time) => {
    const progress = (time % duration) / duration
    progressRef.current = progress
    if (circleRef.current) {
      const angle = progress * 2 * Math.PI
      const radius = 50
      const x = 50 + radius * Math.cos(angle)
      const y = 50 + radius * Math.sin(angle)
      circleRef.current.style.left = `${x}%`
      circleRef.current.style.top = `${y}%`
    }
  })

  return (
    <div className={`relative ${containerClassName}`}>
      <div className="absolute inset-0 overflow-hidden rounded-2xl">
        <div
          ref={circleRef}
          className={`absolute w-20 h-20 -translate-x-1/2 -translate-y-1/2 rounded-full blur-xl ${borderClassName || 'bg-primary-main/40'}`}
        />
      </div>
      <motion.div
        className={`relative rounded-2xl border border-white/[0.08] bg-surface-dark/80 backdrop-blur-xl ${className}`}
      >
        {children}
      </motion.div>
    </div>
  )
}
