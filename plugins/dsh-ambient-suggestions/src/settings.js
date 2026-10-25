import { createElement as h, useEffect, useState, useSyncExternalStore } from 'react';

/** A standard plugin settings card backed by the host's revisioned config scope. */
export function PredictionSettings({ scope, remote }) {
  const snapshot = useSyncExternalStore(listener => scope.subscribe(listener), () => scope.getSnapshot());
  const [groups, setGroups] = useState([]);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    void remote.preferences(controller.signal).then(result => {
      if (controller.signal.aborted) return;
      if (result.ok) setGroups(result.value.groups);
      else setError('Could not load available prediction models.');
    }, () => { if (!controller.signal.aborted) setError('Could not load available prediction models.'); });
    return () => controller.abort();
  }, [remote]);
  const selected = snapshot.value?.model ?? '';
  const known = groups.some(group => group.models.some(model => `${group.id}/${model.id}` === selected));
  async function save(value) {
    setSaving(true);
    setError('');
    try {
      await scope.mutate([{ op: 'set', path: ['model'], value }], snapshot.revision);
      if (scope.getSnapshot().value?.model !== value) setError('The model setting could not be saved. Refresh and try again.');
    } catch { setError('The model setting could not be saved. Refresh and try again.'); }
    finally { setSaving(false); }
  }
  return h('section', { 'aria-label': 'Ambient Suggestions', style: { padding: '16px', maxWidth: '640px' } },
    h('h3', null, 'Ambient Suggestions'),
    h('p', null, 'Predict a short next message with a real model after each completed answer. Tab inserts the suggestion without sending it.'),
    h('label', null, 'Prediction model ', h('select', {
      'aria-label': 'Prediction model', value: selected,
      disabled: saving || snapshot.status !== 'ready' || !snapshot.writable,
      onChange: event => { void save(event.target.value); }
    }, h('option', { value: '' }, 'Inherit current conversation model'),
    selected && !known && h('option', { value: selected }, `${selected} (not in current catalog)`),
    ...groups.map(group => h('optgroup', { key: group.id, label: group.label }, ...group.models.map(model => h('option', { key: model.id, value: `${group.id}/${model.id}` }, model.name)))))),
    h('p', null, 'Predictions use the configured provider and may incur normal model costs. Unavailable routes leave the normal placeholder unchanged.'),
    error && h('p', { role: 'alert' }, error));
}
