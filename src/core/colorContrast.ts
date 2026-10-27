/** Choose a readable text color for an opaque #RRGGBB background. */
export function contrastTextForHex(background: string): '#111111' | '#ffffff' {
  const channels = [1, 3, 5].map((offset) => {
    const value = Number.parseInt(background.slice(offset, offset + 2), 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  const luminance = channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
  const darkContrast = (luminance + 0.05) / 0.0556;
  const lightContrast = 1.05 / (luminance + 0.05);
  return darkContrast >= lightContrast ? '#111111' : '#ffffff';
}
