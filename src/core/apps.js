'use strict';

// The programs Cargo reads, and the words each one uses for its parts.

const APPS = {
  aep: {
    app: 'After Effects',
    short: 'AE',
    extensions: ['aep', 'aepx'],
    labels: {
      item: 'footage item',
      items: 'Footage',
      folder: 'AE folder',
      comp: 'Comp',
      comps: 'Comps',
      compsLong: 'Compositions',
      topLevel: 'Top-level compositions',
      layer: 'Layer',
      source: 'Source',
      effects: 'Effects',
      effect: 'effect',
      thirdParty: 'Third-party',
      open: 'Open in AE',
      openLong: 'Open this project in After Effects',
      usedRule: 'An item is used when a layer in any composition uses it. Data files read by expressions (footage("…")) count too.',
      removeUnusedHint: 'In After Effects, File › Dependencies › Remove Unused Footage removes them from the project too.',
    },
  },
  flp: {
    app: 'FL Studio',
    short: 'FL',
    extensions: ['flp'],
    labels: {
      item: 'sample',
      items: 'Samples',
      folder: 'Channel',
      comp: 'Pattern',
      comps: 'Patterns',
      compsLong: 'Patterns and playlist',
      topLevel: 'Playlist',
      layer: 'Channel',
      source: 'Sample',
      effects: 'Plugins',
      effect: 'plugin',
      thirdParty: 'VST',
      open: 'Open in FL Studio',
      openLong: 'Open this project in FL Studio',
      usedRule: 'A sample is used when it’s on the playlist, or when its channel plays notes in a pattern that is. Files in your recording and render folders that no project uses show up as “Not in project”.',
      removeUnusedHint: 'The channels stay in the project; remove them in FL Studio’s channel rack if you like.',
    },
  },
};
APPS.aepx = APPS.aep;

const PROJECT_EXT = /\.(aepx?|flp)$/i;

function appFor(format) {
  return APPS[format] || APPS.aep;
}

module.exports = { APPS, PROJECT_EXT, appFor };
