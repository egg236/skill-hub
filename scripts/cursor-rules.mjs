// Historical .md releases retain their original targets; current rules use Cursor MDC.
export function payloadTarget(id, source) {
  if (source.startsWith('skills/')) return `.agents/${source}`;
  if (source.startsWith('rules/') && source.endsWith('.mdc')) return `.cursor/rules/skill-hub/${id}/${source.slice(6)}`;
  return `.agents/skill-hub/${id}/${source}`;
}

export function validateCursorRule(source, data) {
  if (!source.startsWith('rules/') || !source.endsWith('.mdc')) return;
  const text = new TextDecoder('utf-8', { fatal: true }).decode(data).replace(/\r\n/g, '\n');
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/)?.[1];
  if (frontmatter === undefined || text.includes('\0')) throw new Error(`Некорректный Cursor rule: ${source}. Нужен YAML frontmatter между --- и ---.`);
  const always = frontmatter.split('\n').filter(line => /^alwaysApply\s*:/.test(line));
  if (always.length !== 1 || !/^alwaysApply:\s*(true|false)\s*(?:#.*)?$/.test(always[0])) {
    throw new Error(`Некорректный Cursor rule: ${source}. Укажи alwaysApply: true или false.`);
  }
}

export function makeCursorRule(description, instructions) {
  const text = instructions.replace(/\r\n/g, '\n');
  if (text.startsWith('---\n')) {
    validateCursorRule('rules/module.mdc', Buffer.from(text));
    return text;
  }
  return `---\ndescription: ${JSON.stringify(description)}\nglobs: ""\nalwaysApply: true\n---\n\n${text.trim()}\n`;
}

export function upgradeCursorRules(module) {
  return { ...module, payload: module.payload.map(file => {
    if (!file.source.startsWith('rules/') || !file.source.endsWith('.md')) return file;
    const source = file.source + 'c';
    return { ...file, source, target: payloadTarget(module.id, source), data: Buffer.from(makeCursorRule(module.description, file.data.toString('utf8'))) };
  }) };
}
