const start = '# skill-hub:ignore:start';
const end = '# skill-hub:ignore:end';

export function cursorIgnoreBytes(current) {
  let text = '';
  try { if (current) text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(current); }
  catch { throw new Error('.cursorignore должен быть в UTF-8. Файл не изменён.'); }
  if (text.includes('\0')) throw new Error('.cursorignore содержит NUL. Файл не изменён.');
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const block = [start, '# Archives, history and inactive module versions', '.skill-hub/', end, ''].join(newline);
  if (text.endsWith(block)) return null;
  if (text.includes(start) || text.includes(end)) {
    const pattern = /^# skill-hub:ignore:start\r?\n[\s\S]*?^# skill-hub:ignore:end(?:\r?\n|$)/gm;
    const matches = [...text.matchAll(pattern)];
    if (matches.length !== 1 || text.split(start).length !== 2 || text.split(end).length !== 2) throw new Error('Повреждён служебный блок skill-hub в .cursorignore.');
    text = text.replace(pattern, '');
  }
  return Buffer.from(text + (text && !text.endsWith('\n') ? newline : '') + block);
}
