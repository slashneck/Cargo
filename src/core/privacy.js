'use strict';

// Private packages: nothing in them may point back to the person who made
// them. That covers file paths (they contain user and folder names), the XMP
// save history with its times and time zone, and the manifest.

const os = require('os');
const path = require('path');

// Absolute paths: Windows drive or UNC paths, and macOS/Linux home or volume paths.
const WIN_PATH = /(?:[A-Za-z]:|\\\\[^\\/\s"<>|]+)(?:[\\/][^\\/\0\r\n"<>|:*?]+)+[\\/]?/g;
const POSIX_PATH = /\/(?:Users|Volumes|home|mnt|media|private|var\/folders)(?:\/[^/\0\r\n"<>]+)+\/?/g;

function lastSegment(p) {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** Replaces every absolute path in `text` with just its file name. */
function scrubPaths(text) {
  return text.replace(WIN_PATH, lastSegment).replace(POSIX_PATH, lastSegment);
}

/** An XMP packet with nothing but the file format in it. */
function neutralXmp() {
  return (
    '<?xpacket begin="\ufeff" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/">' +
    '<dc:format>application/vnd.adobe.aftereffects.project</dc:format>' +
    '</rdf:Description></rdf:RDF></x:xmpmeta>\n<?xpacket end="w"?>'
  );
}

/** Folder the private package's paths are anchored to: only the package name is visible. */
function neutralRoot(packageName) {
  return process.platform === 'win32' ? `C:\\${packageName}` : `/${packageName}`;
}

function neutralPath(root, rel) {
  return path.join(root, ...rel.split('/'));
}

/** Words that identify this computer's user and must not appear in a private package. */
function identifyingStrings() {
  const out = new Set();
  try {
    const name = os.userInfo().username;
    if (name && name.length >= 3) out.add(name);
  } catch {
    // No user info available.
  }
  const home = os.homedir();
  if (home && home.length >= 4) out.add(home);
  const host = os.hostname();
  if (host && host.length >= 3 && !/^localhost$/i.test(host)) out.add(host);
  return [...out];
}

/** Counts how often any identifying string occurs in `buf` (UTF-8 and UTF-16). */
function findLeaks(buf, needles = identifyingStrings()) {
  const found = [];
  for (const n of needles) {
    let count = 0;
    for (const variant of new Set([n, n.toLowerCase(), n.toUpperCase()])) {
      for (const enc of ['utf8', 'utf16le']) {
        const needle = Buffer.from(variant, enc);
        for (let at = buf.indexOf(needle); at !== -1; at = buf.indexOf(needle, at + needle.length)) count++;
      }
    }
    if (count) found.push({ text: n, count });
  }
  return found;
}

module.exports = { scrubPaths, neutralXmp, neutralRoot, neutralPath, identifyingStrings, findLeaks, lastSegment };
