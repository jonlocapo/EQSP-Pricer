import { useEffect, useRef, useState } from 'react';
import { searchSymbols, type SymbolMatch } from '../services/symbolSearch';

interface Props {
  ticker: string;
  displayName: string;
  onPick: (m: SymbolMatch) => void;
}

/**
 * Yahoo-Finance-style ticker search: type a name or symbol, pick from the
 * dropdown. Search failures are shown inline — never silent.
 */
export function TickerSearch({ ticker, displayName, onPick }: Props) {
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState(false);
  const [matches, setMatches] = useState<SymbolMatch[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [highlight, setHighlight] = useState(0);
  const debounceRef = useRef<number | null>(null);
  const seqRef = useRef(0);
  const rootRef = useRef<HTMLDivElement>(null);

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

  function pick(m: SymbolMatch) {
    onPick(m);
    setEditing(false);
    setQuery('');
    setMatches([]);
    setError(null);
  }

  return (
    <div className="field ticker-search" ref={rootRef}>
      <div className="field-label">
        <span>Underlying</span>
        {ticker && <span className="ticker-badge">{ticker}</span>}
      </div>
      <input
        className="input"
        placeholder="Search name or ticker…"
        value={editing ? query : displayName}
        onFocus={() => {
          setEditing(true);
          setQuery('');
        }}
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
            pick(matches[highlight]);
          } else if (e.key === 'Escape') {
            setEditing(false);
          }
        }}
      />
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
