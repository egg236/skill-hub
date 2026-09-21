import { validateDesignFiles } from './agent-drafts.mjs';

const root = 'skills/pet-ui-direction/assets/design/';
export function designSpec(module, input) {
  if (module.id !== 'ui-direction') throw new Error('Создание mood-наборов доступно в ui-direction.');
  if (typeof input.name !== 'string' || input.name.length > 63 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(input.name) || /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(input.name)) throw new Error('ID дизайна: до 63 латинских букв, цифр и дефисов, в нижнем регистре.');
  if (typeof input.title !== 'string' || !input.title.trim() || input.title.length > 200 || /[\r\n\0]/.test(input.title)) throw new Error('Укажи название дизайна одной строкой.');
  const prefix = `${root}moods/${input.name}/`;
  if (module.payload.some(file => file.source.startsWith(prefix)) || module.choices?.some(group => group.id === 'moods' && group.options.some(option => option.id === input.name))) throw new Error('Дизайн с таким ID уже существует. Выбери другой ID или редактируй его файлы.');
  return { prefix, title: input.title.trim() };
}
export function designAgentInput(module, input) {
  const { title } = designSpec(module, input);
  const context = module.payload.filter(file => [root + 'ANTI_SLOP.md', root + 'COPY_BASE.md', root + 'README.md'].includes(file.source));
  return { kind: 'design', name: input.name, task: input.task, content: JSON.stringify({ title,
    existingMoods: module.choices?.find(group => group.id === 'moods')?.options.map(option => option.id) || [],
    sharedFiles: context.map(file => ({ path: file.source, content: file.data.toString('utf8') })) }) };
}
export function designChanges(module, input) {
  const { prefix, title } = designSpec(module, input);
  const files = validateDesignFiles(input.files);
  const choices = structuredClone(module.choices || []);
  let moods = choices.find(group => group.id === 'moods');
  if (!moods) { moods = { id: 'moods', title: 'UI moods', multiple: true, default: [], options: [] }; choices.push(moods); }
  moods.options.push({ id: input.name, title, paths: [prefix] });
  return { choices, edits: files.map(file => ({ file: prefix + file.path, data: Buffer.from(file.content) })) };
}
