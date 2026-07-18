import { createContext, useContext } from 'react';

/**
 * The Price/Solve button + greeks checkbox visually live in the right-hand
 * results panel, but the logic (disabled state, tooltip, handlers) stays
 * owned by each page's ActionRow invocation exactly as before. ActionRow
 * portals its rendered content into this node instead of rendering it
 * inline, so page components need no changes beyond this indirection.
 */
export const ActionPortalContext = createContext<HTMLDivElement | null>(null);

export function useActionPortalNode(): HTMLDivElement | null {
  return useContext(ActionPortalContext);
}
