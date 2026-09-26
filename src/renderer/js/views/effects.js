// Effects & plugins used by the project.

import { h, plural } from '../util.js';
import { icon } from '../icons.js';
import { state, compById } from '../state.js';
import { showComp } from '../actions.js';

export function renderEffects() {
  const p = state.project;
  const used = p.effects.filter((e) => e.count > 0);
  const defined = p.effects.filter((e) => e.count === 0);
  const thirdParty = used.filter((e) => !e.builtIn);
  const row = (e) =>
    h(
      'tr',
      h('td.strong', e.displayName),
      h('td.mono.dim', e.matchName),
      h('td', e.builtIn ? h('span.pill', e.pseudo ? 'Preset / pseudo' : 'Built-in') : h('span.pill.missing', icon('plug', 'sm'), 'Third-party')),
      h('td.r.num', e.count ? String(e.count) : '—'),
      h(
        'td',
        h(
          'div.row',
          { style: { flexWrap: 'wrap', gap: '4px' } },
          ...e.comps.slice(0, 4).map((id) => {
            const c = compById(id);
            return c ? h('button.btn.ghost.sm', { type: 'button', onclick: () => showComp(id) }, icon('comp', 'sm'), h('span.ellipsis', { style: { maxWidth: '160px' } }, c.name)) : null;
          }),
          e.comps.length > 4 ? h('span.dimmer', `+${e.comps.length - 4}`) : null,
        ),
      ),
    );
  return h(
    'div.pane',
    h(
      'div.pane-inner',
      thirdParty.length
        ? h('div.notice.warn', icon('plug'), h('div', h('b', `${plural(thirdParty.length, 'third-party effect')} ${thirdParty.length === 1 ? 'is' : 'are'} used. `), 'Anyone opening this project needs these plugins installed, or the layers will render differently.'))
        : h('div.notice.ok', icon('checkCircle'), h('div', h('b', 'No third-party plugins needed. '), 'Every effect ships with After Effects.')),
      h(
        'div.card',
        { style: { padding: 0, overflow: 'hidden' } },
        used.length
          ? h('table.simple-table', h('thead', h('tr', h('th', 'Effect'), h('th', 'Match name'), h('th', 'Source'), h('th.r', 'Uses'), h('th', 'Compositions'))), h('tbody', ...used.map(row)))
          : h('div.empty-note', { style: { margin: '16px' } }, 'No layer in this project uses an effect.'),
      ),
      defined.length
        ? h('details', h('summary', { style: { cursor: 'pointer', color: 'var(--text-3)' } }, `${plural(defined.length, 'other effect')} known to the project but not on any layer`), h('div.card', { style: { padding: 0, overflow: 'hidden', marginTop: '10px' } }, h('table.simple-table', h('tbody', ...defined.map(row)))))
        : null,
    ),
  );
}
