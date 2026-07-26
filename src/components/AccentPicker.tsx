import { useEffect, useRef } from 'react';
import { ACCENTS, accentVars, contrastOn } from '../theme/accents';

export interface AccentPickerProps {
  accentId: string;
  onPick: (id: string) => void;
  onClose: () => void;
}

/** Swatch preview colour. The picker shows the light-theme base in both
 * themes, so a swatch always names the colour the user asked for rather than
 * the lightened dark-theme derivative. */
function swatchColour(base: string): string {
  return accentVars(base, 'light').accent;
}

/**
 * The accent picker, opened by the Alt+Shift+A shortcut (see useAccent).
 *
 * A picker reached only by a shortcut still has to be usable once it is open,
 * so it takes focus, moves the selection with the arrow keys, commits on Enter
 * or Space, and closes on Escape.
 */
export function AccentPicker({ accentId, onPick, onClose }: AccentPickerProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Focus the selected swatch, so the arrow keys start from where the user
    // already is rather than from the first swatch.
    const selected = listRef.current?.querySelector<HTMLButtonElement>('.accent-swatch.selected');
    (selected ?? listRef.current?.querySelector<HTMLButtonElement>('.accent-swatch'))?.focus();
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
      return;
    }
    const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    e.preventDefault();
    const index = ACCENTS.findIndex((a) => a.id === accentId);
    const next = ACCENTS[(index + step + ACCENTS.length) % ACCENTS.length];
    onPick(next.id);
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('.accent-swatch');
    buttons?.[(index + step + ACCENTS.length) % ACCENTS.length]?.focus();
  };

  return (
    <div className="accent-backdrop" onClick={onClose}>
      <div
        className="accent-popover"
        role="dialog"
        aria-label="Accent colour"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="accent-title">Accent</div>
        <div className="accent-row" ref={listRef}>
          {ACCENTS.map((a) => {
            const colour = swatchColour(a.base);
            return (
              <div className="accent-cell" key={a.id}>
                <button
                  type="button"
                  className={`accent-swatch ${a.id === accentId ? 'selected' : ''}`}
                  style={{ background: colour, color: contrastOn(colour) }}
                  aria-label={a.name}
                  aria-pressed={a.id === accentId}
                  onClick={() => onPick(a.id)}
                >
                  {a.id === accentId ? '✓' : ''}
                </button>
                <span className="accent-name">{a.name}</span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
