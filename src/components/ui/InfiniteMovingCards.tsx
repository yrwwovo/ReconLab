import { useEffect, useRef, useState } from 'react'
import { cn } from '../../lib/utils'

export function InfiniteMovingCards({
  items,
  direction = 'left',
  speed = 'normal',
  pauseOnHover = true,
  className,
}: {
  items: { quote: string; name: string; title: string }[]
  direction?: 'left' | 'right'
  speed?: 'fast' | 'normal' | 'slow'
  pauseOnHover?: boolean
  className?: string
}) {
  const containerRef = useRef<HTMLDivElement>(null)
  const scrollerRef = useRef<HTMLUListElement>(null)
  const [start, setStart] = useState(false)

  useEffect(() => {
    if (containerRef.current && scrollerRef.current) {
      const scrollerContent = Array.from(scrollerRef.current.children)
      scrollerContent.forEach((item) => {
        const duplicatedItem = item.cloneNode(true)
        scrollerRef.current?.appendChild(duplicatedItem)
      })

      const speedMap = { fast: '20s', normal: '40s', slow: '80s' }
      containerRef.current.style.setProperty('--animation-duration', speedMap[speed])
      containerRef.current.style.setProperty('--animation-direction', direction === 'left' ? 'forwards' : 'reverse')
      setStart(true)
    }
  }, [direction, speed])

  return (
    <div
      ref={containerRef}
      className={cn('scroller relative z-20 max-w-7xl overflow-hidden [mask-image:linear-gradient(to_right,transparent,white_20%,white_80%,transparent)]', className)}
    >
      <ul
        ref={scrollerRef}
        className={cn('flex min-w-full shrink-0 gap-4 py-4 w-max flex-nowrap', start && 'animate-scroll', pauseOnHover && 'hover:[animation-play-state:paused]')}
        style={{
          animation: start ? `scroll var(--animation-duration, 40s) var(--animation-direction, forwards) linear infinite` : 'none',
        }}
      >
        {items.map((item, idx) => (
          <li
            className="w-[350px] max-w-full relative rounded-2xl border border-white/[0.06] bg-white/[0.02] flex-shrink-0 px-8 py-6"
            key={idx}
          >
            <blockquote>
              <p className="text-sm leading-relaxed text-text-main">{item.quote}</p>
              <footer className="mt-4">
                <p className="text-sm font-medium text-text-light">{item.name}</p>
                <p className="text-xs text-text-dark">{item.title}</p>
              </footer>
            </blockquote>
          </li>
        ))}
      </ul>
      <style>{`
        @keyframes scroll {
          to { transform: translate(calc(-50% - 0.5rem)); }
        }
        .animate-scroll { animation: scroll var(--animation-duration, 40s) var(--animation-direction, forwards) linear infinite; }
      `}</style>
    </div>
  )
}
