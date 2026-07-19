import type { ReactNode } from 'react';

interface CardProps {
  title: string;
  children: ReactNode;
}

export function Card({ title, children }: CardProps) {
  return (
    <section className="card">
      <h3 className="card-title">{title}</h3>
      <div className="field-group">{children}</div>
    </section>
  );
}
