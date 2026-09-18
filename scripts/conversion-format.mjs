import path from 'node:path';
import { read, hash, splitBlock } from './hub.mjs';
import { validateCursorRule } from './cursor-rules.mjs';
import { portableId } from './conversion-plan.mjs';
function userAgentText(text) { const parts = splitBlock(text); return parts.before + parts.after; }
export function itemName(item) {
  const raw = item.kind === 'skill' && item.path !== item.entrypoint ? path.posix.basename(item.path) : path.posix.basename(item.path).replace(/\.mdc?$/i, '');
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50).replace(/-$/, '');
  return portableId(slug) ? slug : item.kind + '-' + hash(item.path).slice(0, 8);
}
function skillText(text, name, description) {
  const normalized = text.replace(/\r\n/g, '\n');
  if (normalized.startsWith('---\n') && normalized.includes(`\nname: ${name}\n`) && /\ndescription: .+\n/.test(normalized) && normalized.indexOf('\n---\n', 4) >= 0) return text;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  // Preserve supported frontmatter when it can be identified, and keep legacy prose verbatim.
  if (header && header[1].split(/\r?\n/).every(line => !line.trim() || /^\s|^[\w-]+\s*:|^#/.test(line))) {
    const rest = header[1].split(/\r?\n/).filter(line => !/^name\s*:/.test(line));
    if (!rest.some(line => /^description:\s*\S/.test(line))) {
      for (let i = rest.length - 1; i >= 0; i--) if (/^description\s*:/.test(rest[i])) rest.splice(i, 1);
      rest.push('description: ' + JSON.stringify(description));
    }
    return '---' + eol + 'name: ' + name + eol + rest.join(eol) + eol + '---' + eol + text.slice(header[0].length);
  }
  return '---' + eol + 'name: ' + name + eol + 'description: ' + JSON.stringify(description) + eol + '---' + eol + eol + text;
}
export function payloadFor(project, item, name, description) {
  const root = item.kind === 'skill' ? `skills/${name}/` : item.kind === 'rule' ? 'rules/' : 'agents/';
  return item.files.map(file => {
    const entry = file.path === item.entrypoint;
    const relative = item.kind === 'skill' ? entry ? 'SKILL.md' : file.path.slice(item.path.length + 1) : name + (item.kind === 'rule' ? '.mdc' : '.md');
    let data = read(project, file.path);
    if (entry && item.kind === 'skill') data = Buffer.from(skillText(file.content, name, description));
    if (entry && item.kind === 'rule') {
      let text = item.path === 'AGENTS.md' ? userAgentText(file.content) : file.content;
      if (!text.trim()) throw new Error('В ' + item.path + ' нет собственных инструкций вне блока skill-hub.');
      if (item.path.endsWith('.mdc')) validateCursorRule('rules/imported.mdc', data);
      else {
        const always = ['AGENTS.md', 'CLAUDE.md', '.cursorrules'].includes(item.path);
        text = `---\ndescription: ${JSON.stringify(description)}\nglobs: ""\nalwaysApply: ${always}\n---\n\n` + text;
        data = Buffer.from(text);
      }
    }
    return { source: root + relative, data, original: file.path, before: file.content, changed: !data.equals(read(project, file.path)) };
  });
}
