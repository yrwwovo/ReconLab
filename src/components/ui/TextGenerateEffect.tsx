import { useEffect, useState } from 'react'
import { motion, stagger, useAnimate } from 'framer-motion'

export function TextGenerateEffect({
  words,
  className = '',
}: {
  words: string
  className?: string
}) {
  const [scope, animate] = useAnimate()
  const wordsArray = words.split('')
  const [started, setStarted] = useState(false)

  useEffect(() => {
    if (!started) {
      setStarted(true)
      animate(
        'span',
        { opacity: 1, filter: 'blur(0px)' },
        { duration: 0.5, delay: stagger(0.05) }
      )
    }
  }, [started, animate])

  return (
    <motion.div ref={scope} className={className}>
      {wordsArray.map((char, idx) => (
        <motion.span
          key={idx}
          className="inline-block"
          style={{ opacity: 0, filter: 'blur(8px)' }}
        >
          {char === ' ' ? '\u00A0' : char}
        </motion.span>
      ))}
    </motion.div>
  )
}
