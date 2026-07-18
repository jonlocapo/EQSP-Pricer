import type { ReactNode } from 'react';

interface CardProps {
  title: string;
  children: ReactNode;
}

export function Card({ title, children }: CardProps) {
  return (
    <section className="section">
      <h3 className="section-title">{title}</h3>
      <div className="field-group">{children}</div>
    </section>
  );
}
