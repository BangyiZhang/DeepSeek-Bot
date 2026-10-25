import { createElement, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { bindPredictivePlaceholder } from './placeholder.js';
import { createPredictionController } from './prediction.js';
import { TYPERT_REMOTE } from './rpc.js';
import { PredictionSettings } from './settings.js';

/** Request one real prediction after a completed turn, scoped to this composer. */
export function PredictivePlaceholderManager({ sessionId, useSessions, useSessionStatus, useInput, inputActions, requestPrediction }) {
  const outline = useSessions(list => list.projectionsBySession?.[sessionId]?.values?.turnOutline);
  const last = Array.isArray(outline) ? outline.at(-1) : null;
  const turnKey = last && Number.isSafeInteger(last.turn) && Number.isSafeInteger(last.seq) && last.response ? `${last.turn}:${last.seq}` : '';
  const running = useSessionStatus(map => map.get(sessionId)?.running === true);
  const pending = useSessionStatus(map => Boolean(map.get(sessionId)?.pendingInteraction));
  const input = useInput(state => state);
  const anchor = useRef(null);
  const attempted = useRef('');
  const [result, setResult] = useState({ key: '', text: '' });
  const key = `${sessionId}:${turnKey}`;
  const controller = useMemo(() => createPredictionController({
    request: requestPrediction,
    publish: text => setResult({ key, text })
  }), [requestPrediction, key]);
  const eligible = Boolean(turnKey && !running && !pending && !input?.draft?.length && !input?.attachmentIds?.length);

  useLayoutEffect(() => {
    if (eligible && attempted.current !== key) {
      attempted.current = key;
      void controller.start({ sessionId, turnKey, language: document.documentElement.lang || navigator.language });
    }
    return () => controller.cancel();
  }, [controller, eligible, sessionId, turnKey]);
  useLayoutEffect(() => bindPredictivePlaceholder({
    sessionId, anchor: anchor.current,
    prediction: eligible && result.key === key ? result.text : '', inputActions
  }), [sessionId, eligible, key, result, inputActions]);
  return createElement('span', { ref: anchor, hidden: true, 'data-ambient-anchor': sessionId });
}

export const name = 'client-ui-ambient-suggestions';
export const inject = ['slots', 'remote', 'configForms'];
export function apply(ctx) {
  ctx.effect(async () => {
    const unmount = await ctx.remote.$mount(TYPERT_REMOTE);
    const unregister = ctx.inject(['remote.ambientSuggestions'], child => {
      const requestPrediction = async (request, signal) => {
        const response = await child.remote.ambientSuggestions.predict(request, signal);
        if (!response.ok) throw new Error(response.error?.message ?? 'Prediction unavailable');
        return response.value;
      };
      child.slots.inject('conversation.input.dock', () => child.slots.register({
        name: 'conversation.input.dock', id: 'predictive-placeholder', order: -100,
        inject: () => ({ requestPrediction })
      }, PredictivePlaceholderManager));
      child.effect(() => child.configForms.whileServed(['client-ui-ambient-suggestions'], () => child.slots.inject('plugins.item', () => child.slots.register({
        name: 'plugins.item', id: 'ambient-suggestions', order: 20, label: () => 'Ambient Suggestions',
        inject: () => ({ scope: child.configForms.get('client-ui-ambient-suggestions'), remote: child.remote.ambientSuggestions })
      }, PredictionSettings))));
    });
    return async () => { unregister(); await unmount(); };
  }, 'ambient prediction remote');
}
