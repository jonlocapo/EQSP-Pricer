import { useEffect, useRef, useState } from 'react';
import { searchSymbols, type SymbolMatch } from '../services/symbolSearch';

export interface TickerChip {
  /** Short text shown in the chip, normally the ticker. */
  label: string;
  /** Full name, shown on hover. */
  title?: string;
}

interface Props {
  ticker: string;
  displayName: string;
  onPick: (m: SymbolMatch) => void;
  /** Field label. Defaults to "Underlying". The basket panel overrides it,
   * because two fields both labelled "Underlying" in one column gives the
   * user no way to tell the note's own name from the add-a-leg search. */
  label?: string;
  /**
   * One chip per underlying in the pool, shown on the label row.
   *
   * The chips sit next to the label and WRAP as whole words. A chip is a
   * ticker, so breaking one across lines makes it unreadable; running out of
   * room moves the whole chip to the next line instead. When omitted, the
   * component falls back to a single chip for `ticker`, which is what a
   * plain single-name trade shows.
   */
  chips?: TickerChip[];
  /**
   * Adds the highlighted match as a NEW leg, rather than replacing the
   * current underlying. Supplying it renders a `+` button beside the search
   * box. Omit it and the search box occupies the full width, exactly as a
   * single-name trade has always looked.
   */
  onAdd?: (m: SymbolMatch) => void;
  /** Blocks `+`, for example once the basket is full. The reason shows on
   * hover, so a greyed-out button is never unexplained. */
  addDisabled?: boolean;
  addDisabledReason?: string;
}

/**
 * Yahoo-Finance-style ticker search: type a name or symbol, pick from the
 * dropdown. Search failures are shown inline — never silent.
 */
export function TickerSearch({
  ticker,
  displayName,
  onPick,
  label = 'Underlying',
  chips,
  onAdd,
  addDisabled = false,
  addDisabledReason,
}: Props) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [matches, setMatches] = useState<SymbolMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const debounceRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    if (query.trim().length < 1) {
      setMatches([]);
      setError(null);
      return;
    }
    debounceRef.current = window.setTimeout(async () => {
      const seq = ++seqRef.current;
      setSearching(true);
      setError(null);
      try {
        // Local hits paint at once, so a name the built-in list knows appears
        // instantly instead of behind up to four seconds of relay spinner.
        const res = await searchSymbols(query, (localMatches) => {
          if (seq !== seqRef.current) return;
          setMatches(localMatches);
          setHighlight(0);
        });
        if (seq !== seqRef.current) return;
        setMatches(res);
        setHighlight(0);
        if (res.length === 0) setError('No matches. Try the exact ticker.');
      } catch (e) {
        if (seq !== seqRef.current) return;
        setMatches([]);
        // Name the cause and give the way out. Search rides public CORS relays,
        // which rate-limit and go down, but pricing never needs the lookup: an
        // exact Yahoo-style symbol typed straight in works without it.
        const why = e instanceof Error ? e.message : 'failed';
        setError(`Search unavailable (${why}). Type the exact symbol, e.g. RHM.DE`);
      } finally {
        if (seq === seqRef.current) setSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current !== null) window.clearTimeout(debounceRef.current);
    };
  }, [query, editing]);

  useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setEditing(false);
      }
    }
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, []);

  /** Clears the query and the dropdown. `keepEditing` decides whether the box
   * stays armed for another search.
   *
   * WHY THE BLUR MATTERS. `editing` is turned on by the input's `onFocus`,
   * which only fires when focus ARRIVES. Leaving the box focused with
   * `editing` false stranded it: clicking the already-focused input fired no
   * focus event, so the next keystroke never reached the search and the box
   * kept displaying the underlying's name. Dropping focus makes the next
   * click a real focus event again. */
  function reset(keepEditing = false) {
    setQuery('');
    setMatches([]);
    setError(null);
    setEditing(keepEditing);
    if (!keepEditing) inputRef.current?.blur();
  }

  function pick(m: SymbolMatch) {
    onPick(m);
    reset();
  }

  /** The match `+` would add: whatever the dropdown is highlighting. */
  const addable = onAdd && matches.length > 0 ? matches[highlight] : undefined;

  function add() {
    if (!onAdd || !addable || addDisabled) return;
    onAdd(addable);
    // Stay armed. Building a basket means adding several names in a row, so
    // the box clears and waits for the next one instead of closing.
    reset(true);
    inputRef.current?.focus();
  }

  const shownChips: TickerChip[] = chips ?? (ticker ? [{ label: ticker }] : []);

  const addTitle = addDisabled
    ? (addDisabledReason ?? 'Cannot add another leg.')
    : addable
      ? `Add ${addable.symbol} as another underlying`
      : 'Search for an underlying, then add it';

  return (
    <div className="field ticker-search" ref={rootRef}>
      <div className="field-label ticker-label">
        <span>{label}</span>
        {shownChips.length > 0 && (
          <span className="ticker-chips">
            {shownChips.map((c, i) => (
              <span className="ticker-badge" key={`${c.label}-${i}`} title={c.title}>
                {c.label}
              </span>
            ))}
          </span>
        )}
      </div>
      <div className="ticker-input-row">
        <input
          ref={inputRef}
          className="input"
          placeholder="Search name or ticker…"
          value={editing ? query : displayName}
          onFocus={() => {
            setEditing(true);
            setQuery('');
          }}
          // A click on an ALREADY focused box fires no focus event. Without
          // this the box could sit focused but not editing, and swallow
          // everything typed into it.
          onClick={() => setEditing(true)}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (!editing || matches.length === 0) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setHighlight((h) => Math.min(h + 1, matches.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setHighlight((h) => Math.max(h - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              // Shift+Enter adds a leg, plain Enter replaces the underlying.
              // Both reach the same two actions the mouse has.
              if (e.shiftKey && onAdd) add();
              else pick(matches[highlight]);
            } else if (e.key === 'Escape') {
              setEditing(false);
            }
          }}
        />
        {onAdd && (
          <button
            type="button"
            className="btn btn-sm ticker-add"
            disabled={addDisabled || !addable}
            title={addTitle}
            // The dropdown closes on mousedown outside it, which would clear
            // `matches` before the click landed. Act on mousedown instead.
            onMouseDown={(e) => {
              e.preventDefault();
              add();
            }}
          >
            +
          </button>
        )}
      </div>
      {editing && (searching || matches.length > 0 || error) && (
        <div className="ticker-dropdown">
          {searching && <div className="ticker-row muted">Searching…</div>}
          {matches.map((m, i) => (
            <button
              key={`${m.symbol}-${i}`}
              type="button"
              className={`ticker-row ${i === highlight ? 'highlight' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => pick(m)}
            >
              <span className="ticker-sym">{m.symbol}</span>
              <span className="ticker-name">{m.name}</span>
              <span className="ticker-meta">
                {m.exchange}
                {m.quoteType !== 'EQUITY' ? ` · ${m.quoteType}` : ''}
              </span>
            </button>
          ))}
          {error && <div className="ticker-row error">{error}</div>}
        </div>
      )}
    </div>
  );
}
