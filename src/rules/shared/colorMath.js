// Color parsing and WCAG contrast math shared by the CSS rules (color-contrast-low, outline-removed).
// Moved here unchanged from color-contrast-low.js so both rules use one implementation.
//
// parseColor only understands literals it can evaluate statically: #rgb, #rrggbb, rgb(r, g, b) with
// integers, and the NAMED_COLORS below. Everything else (var(), currentColor, hsl(), rgba(), gradients,
// other named colors, ...) returns null, meaning "cannot be determined statically".

const NAMED_COLORS = {
  white: '#ffffff', black: '#000000', red: '#ff0000', blue: '#0000ff',
  green: '#008000', gray: '#808080', grey: '#808080', yellow: '#ffff00',
  orange: '#ffa500', purple: '#800080', pink: '#ffc0cb', brown: '#a52a2a',
  cyan: '#00ffff', magenta: '#ff00ff', navy: '#000080', teal: '#008080',
  silver: '#c0c0c0', maroon: '#800000', lime: '#00ff00', aqua: '#00ffff'
};

function hexToRgb(hex) {
  hex = hex.replace('#', '');
  if (hex.length === 3) {
    hex = hex[0] + hex[0] + hex[1] + hex[1] + hex[2] + hex[2];
  }
  if (hex.length !== 6) return null;
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
  return { r, g, b };
}

function parseColor(value) {
  if (!value) return null;
  const v = value.trim().toLowerCase();

  if (v.includes('var(')) return null;

  if (NAMED_COLORS[v]) {
    return hexToRgb(NAMED_COLORS[v]);
  }

  if (v.startsWith('#')) {
    return hexToRgb(v);
  }

  const rgbMatch = v.match(/^rgb\s*\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
  if (rgbMatch) {
    return {
      r: parseInt(rgbMatch[1], 10),
      g: parseInt(rgbMatch[2], 10),
      b: parseInt(rgbMatch[3], 10)
    };
  }

  return null;
}

function getLuminance(r, g, b) {
  let rs = r / 255;
  let gs = g / 255;
  let bs = b / 255;

  rs = rs <= 0.03928 ? rs / 12.92 : Math.pow((rs + 0.055) / 1.055, 2.4);
  gs = gs <= 0.03928 ? gs / 12.92 : Math.pow((gs + 0.055) / 1.055, 2.4);
  bs = bs <= 0.03928 ? bs / 12.92 : Math.pow((bs + 0.055) / 1.055, 2.4);

  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

function getContrastRatio(lum1, lum2) {
  const lighter = Math.max(lum1, lum2);
  const darker = Math.min(lum1, lum2);
  return (lighter + 0.05) / (darker + 0.05);
}

module.exports = { NAMED_COLORS, hexToRgb, parseColor, getLuminance, getContrastRatio };
