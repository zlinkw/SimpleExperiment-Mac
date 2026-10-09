export interface PanelStateFlowControlState {
  documentGeneration: number;
  visible: boolean;
  postedSeq: number;
  deliveredSeq: number;
  renderedSeq: number;
  outstandingRenderSeq: number | null;
  outstandingSince: number | null;
  pendingDirty: boolean;
  pendingImmediate: boolean;
}

export interface PanelStateFlowPostDecision {
  state: PanelStateFlowControlState;
  shouldPost: boolean;
  immediate: boolean;
  reason: "ready" | "hidden" | "awaiting-render";
}

export interface PanelStateRenderAckDecision {
  state: PanelStateFlowControlState;
  accepted: boolean;
  clearedOutstanding: boolean;
  renderAckLatencyMs: number | null;
  shouldFlushPending: boolean;
}

export function createPanelStateFlowControlState(documentGeneration = 0, visible = true): PanelStateFlowControlState {
  return {
    documentGeneration: normalizeSequence(documentGeneration),
    visible: visible === true,
    postedSeq: 0,
    deliveredSeq: 0,
    renderedSeq: 0,
    outstandingRenderSeq: null,
    outstandingSince: null,
    pendingDirty: false,
    pendingImmediate: false,
  };
}

export function beginPanelStateDocument(state: PanelStateFlowControlState, documentGeneration: number, visible = true): PanelStateFlowControlState {
  return createPanelStateFlowControlState(documentGeneration, visible);
}

export function setPanelStateFlowVisibility(state: PanelStateFlowControlState, visible: boolean): PanelStateFlowControlState {
  const nextVisible = visible === true;
  if (!nextVisible && state.visible && state.outstandingRenderSeq !== null && state.renderedSeq < state.outstandingRenderSeq) {
    return {
      ...state,
      visible: false,
      outstandingRenderSeq: null,
      outstandingSince: null,
      pendingDirty: true,
    };
  }
  return { ...state, visible: nextVisible };
}

export function requestPanelStateFlowPost(state: PanelStateFlowControlState, immediate = false, bootstrap = false): PanelStateFlowPostDecision {
  const pending = {
    ...state,
    pendingDirty: true,
    pendingImmediate: state.pendingImmediate || immediate === true || bootstrap === true,
  };
  if (!pending.visible) return { state: pending, shouldPost: false, immediate: pending.pendingImmediate, reason: "hidden" };
  if (pending.outstandingRenderSeq !== null && pending.renderedSeq < pending.outstandingRenderSeq) {
    return { state: pending, shouldPost: false, immediate: pending.pendingImmediate, reason: "awaiting-render" };
  }
  return { state: pending, shouldPost: true, immediate: pending.pendingImmediate, reason: "ready" };
}

export function markPanelStateFlowPosted(state: PanelStateFlowControlState, seq: number, now = Date.now()): PanelStateFlowControlState {
  const normalizedSeq = normalizeSequence(seq);
  if (!normalizedSeq || normalizedSeq <= state.postedSeq) return state;
  if (state.outstandingRenderSeq !== null && state.renderedSeq < state.outstandingRenderSeq) return state;
  return {
    ...state,
    postedSeq: normalizedSeq,
    outstandingRenderSeq: normalizedSeq,
    outstandingSince: Math.max(0, Number.isFinite(now) ? now : Date.now()),
    pendingDirty: false,
    pendingImmediate: false,
  };
}

export function markPanelStateFlowDelivered(state: PanelStateFlowControlState, seq: number): PanelStateFlowControlState {
  const normalizedSeq = normalizeSequence(seq);
  if (!normalizedSeq || normalizedSeq > state.postedSeq) return state;
  return { ...state, deliveredSeq: Math.max(state.deliveredSeq, normalizedSeq) };
}

export function failPanelStateFlowPost(state: PanelStateFlowControlState, seq: number): PanelStateFlowControlState {
  const normalizedSeq = normalizeSequence(seq);
  if (state.outstandingRenderSeq !== normalizedSeq) return state;
  return {
    ...state,
    outstandingRenderSeq: null,
    outstandingSince: null,
    pendingDirty: true,
  };
}

export function acknowledgePanelStateRendered(
  state: PanelStateFlowControlState,
  documentGeneration: number,
  seq: number,
  now = Date.now(),
): PanelStateRenderAckDecision {
  const normalizedGeneration = normalizeSequence(documentGeneration);
  const normalizedSeq = normalizeSequence(seq);
  if (normalizedGeneration !== state.documentGeneration || normalizedSeq === 0 || normalizedSeq > state.postedSeq || normalizedSeq <= state.renderedSeq) {
    return { state, accepted: false, clearedOutstanding: false, renderAckLatencyMs: null, shouldFlushPending: false };
  }
  const clearedOutstanding = state.outstandingRenderSeq !== null && normalizedSeq >= state.outstandingRenderSeq;
  const renderAckLatencyMs = clearedOutstanding && state.outstandingSince !== null
    ? Math.max(0, Math.round((Number.isFinite(now) ? now : Date.now()) - state.outstandingSince))
    : null;
  const next = {
    ...state,
    renderedSeq: normalizedSeq,
    outstandingRenderSeq: clearedOutstanding ? null : state.outstandingRenderSeq,
    outstandingSince: clearedOutstanding ? null : state.outstandingSince,
  };
  return {
    state: next,
    accepted: true,
    clearedOutstanding,
    renderAckLatencyMs,
    shouldFlushPending: clearedOutstanding && next.pendingDirty && next.visible,
  };
}

export function panelStateFlowControlSnapshot(state: PanelStateFlowControlState, now = Date.now()): Record<string, number | boolean | null> {
  return {
    documentGeneration: state.documentGeneration,
    visible: state.visible,
    postedSeq: state.postedSeq,
    deliveredSeq: state.deliveredSeq,
    renderedSeq: state.renderedSeq,
    outstandingRenderSeq: state.outstandingRenderSeq,
    pendingDirty: state.pendingDirty,
    outstandingAgeMs: state.outstandingSince === null ? 0 : Math.max(0, Math.round((Number.isFinite(now) ? now : Date.now()) - state.outstandingSince)),
  };
}

function normalizeSequence(value: number): number {
  return Number.isSafeInteger(value) ? Math.max(0, value) : 0;
}
