import { hash, splitBlock } from './hub.mjs';

export function personalAgentText(text) {
  const parts = splitBlock(text);
  return (parts.before + parts.after).trim();
}
export function sourceMatches(item, module, source) {
  if (item.path !== 'AGENTS.md') return source.revision === item.revision;
  const personal = personalAgentText(item.files[0].content);
  if (source.personalHash) return source.personalHash === hash(personal);
  // Older conversions stored the whole-file revision, including the generated block.
  return module.payload.some(file => file.source.startsWith('rules/') &&
    file.data.toString('utf8').replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, '').trim() === personal);
}
