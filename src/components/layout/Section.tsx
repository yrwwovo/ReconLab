import { createElement, forwardRef, type HTMLAttributes, type ReactNode } from 'react';

/**
 * 响应式 Section 容器组件
 *
 * 强制使用场景：所有首屏/落地页里的 section 块
 *
 * 已内置响应式骨架：
 * - padding-block: clamp(3rem, 10vw, 7rem)
 * - padding-inline: clamp(1rem, 5vw, 3rem)
 * - 内部容器 width: min(100%, 1200px)，自动居中
 * - 手机端自动收缩，禁止自己写固定宽度
 *
 * 用法：
 *   <Section className="bg-zinc-900">
 *     <h2 className="fs-display">标题</h2>
 *     <p className="fs-body">正文</p>
 *   </Section>
 */

type SectionTag = 'section' | 'div' | 'article' | 'header' | 'footer';

interface SectionProps extends HTMLAttributes<HTMLElement> {
  children: ReactNode;
  /** 自定义 section 外层类（如 bg 色、相对定位等） */
  className?: string;
  /** 自定义内部容器类（默认 container-fluid） */
  innerClassName?: string;
  /** 语义化标签，默认 section */
  as?: SectionTag;
}

export const Section = forwardRef<HTMLElement, SectionProps>(
  ({ children, className = '', innerClassName = '', as = 'section', ...props }, ref) => {
    return createElement(
      as,
      {
        ref,
        className: `section-wrap ${className}`,
        ...props,
      },
      createElement('div', { className: `container-fluid ${innerClassName}` }, children)
    );
  }
);

Section.displayName = 'Section';

/**
 * 自适应网格容器（用于卡片、特性、统计数据等等宽元素）
 *
 * 用法：
 *   <Grid>
 *     <Card />
 *     <Card />
 *     <Card />
 *   </Grid>
 *
 * 手机端自动换行为单列，PC 端根据宽度自动铺满
 */
interface GridProps extends HTMLAttributes<HTMLDivElement> {
  children: ReactNode;
  className?: string;
  /** 子项最小宽度，默认 280px。卡片比较大时可以传 320/360 */
  minItemWidth?: number;
}

export const Grid = forwardRef<HTMLDivElement, GridProps>(
  ({ children, className = '', minItemWidth = 280, ...props }, ref) => {
    return (
      <div
        ref={ref}
        className={`grid-auto ${className}`}
        style={{
          gridTemplateColumns: `repeat(auto-fit, minmax(min(${minItemWidth}px, 100%), 1fr))`,
        }}
        {...props}
      >
        {children}
      </div>
    );
  }
);

Grid.displayName = 'Grid';
