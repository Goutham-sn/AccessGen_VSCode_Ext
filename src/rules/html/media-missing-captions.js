const { walkNode } = require('../../parsers/htmlParser');

function getAttr(node, name) {
  return (node.attrs || []).find(a => a.name === name);
}

function getLoc(node) {
  const loc = node.sourceCodeLocation;
  if (!loc) return null;
  const tag = loc.startTag || loc;
  return {
    startLine: tag.startLine - 1,
    endLine: (tag.endLine || tag.startLine) - 1,
    startChar: tag.startCol - 1,
    endChar: (tag.endCol || tag.startCol + 10) - 1
  };
}

function hasCaptionsTrack(node) {
  if (!node.childNodes) return false;
  for (const child of node.childNodes) {
    if (child.tagName === 'track') {
      const kind = getAttr(child, 'kind');
      if (kind && kind.value === 'captions') return true;
    }
  }
  return false;
}

module.exports = {
  id: 'media-missing-captions',
  language: 'html',
  severity: 'critical',
  wcag: 'WCAG 2.1 - 1.2.2 (Level A)',
  check(ast, sourceCode, config) {
    const violations = [];

    walkNode(ast, (node) => {
      if (node.tagName !== 'video' && node.tagName !== 'audio') return;

      const muted = getAttr(node, 'muted');
      if (muted || (node.attrs || []).some(a => a.name === 'muted')) return;

      if (hasCaptionsTrack(node)) return;

      const loc = getLoc(node);
      if (!loc) return;

      violations.push({
        ruleId: 'media-missing-captions',
        severity: 'critical',
        startLine: loc.startLine,
        endLine: loc.endLine,
        startChar: loc.startChar,
        endChar: loc.endChar,
        message: {
          what: 'This media element has no captions track.',
          why: 'Deaf and hard of hearing users cannot access audio content without captions. This affects a significant portion of users.',
          fix: "Add a <track kind='captions' src='captions.vtt' srclang='en' label='English'> element inside the video or audio element.",
          wcag: 'WCAG 2.1 - 1.2.2 (Level A)'
        }
      });
    });

    return violations;
  }
};
