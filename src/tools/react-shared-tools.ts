/**
 * Shared React-specific constants used across React analysis tools.
 */
// ── React stdlib hooks (used as denylist in tracing and inventory) ──
export const REACT_STDLIB_HOOKS = new Set([
  "useState", "useEffect", "useCallback", "useMemo", "useRef",
  "useContext", "useReducer", "useLayoutEffect", "useImperativeHandle",
  "useDebugValue", "useDeferredValue", "useTransition", "useId",
  "useSyncExternalStore", "useInsertionEffect", "useOptimistic",
  "useFormState", "useFormStatus", "use",
]);
