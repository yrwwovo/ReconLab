import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'

export function NumberTicker({
  value,
  direction = 'up',
  delay = 0,
  className,
}: {
  value: number
  direction?: 'up' | 'down'
  delay?: number
  className?: string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const [displayValue, setDisplayValue] = useState(direction === 'up' ? 0 : value)
  const [hasStarted, setHasStarted] = useState(false)

  useEffect(() => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting && !hasStarted) {
          setHasStarted(true)
        }
      },
      { threshold: 0.5 }
    )
    if (ref.current) observer.observe(ref.current)
    return () => observer.disconnect()
  }, [hasStarted])

  useEffect(() => {
    if (!hasStarted) return
    const timeout = setTimeout(() => {
      const startValue = direction === 'up' ? 0 : value
      const endValue = direction === 'up' ? value : 0
      const duration = 2000
      const startTime = performance.now()

      const tick = (now: number) => {
        const elapsed = now - startTime
        const progress = Math.min(elapsed / duration, 1)
        const eased = 1 - Math.pow(1 - progress, 3)
        const current = Math.round(startValue + (endValue - startValue) * eased)
        setDisplayValue(current)
        if (progress < 1) requestAnimationFrame(tick)
      }
      requestAnimationFrame(tick)
    }, delay)
    return () => clearTimeout(timeout)
  }, [hasStarted, value, direction, delay])

  return (
    <span ref={ref} className={cn('inline-block tabular-nums', className)}>
      {displayValue.toLocaleString()}
    </span>
  )
}
