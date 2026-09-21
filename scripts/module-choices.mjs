const idPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const fail = message => { throw new Error(message); };
export const pathMatches = (file, prefix) => prefix.endsWith('/') ? file.startsWith(prefix) : file === prefix;
export function choiceOwner(module, file) {
  for (const group of module.choices || []) for (const option of group.options) {
    if (option.paths.some(prefix => pathMatches(file, prefix))) return { group: group.id, option: option.id };
  }
  return null;
}
export function validateChoices(module) {
  if (module.choices === undefined) return;
  if (!Array.isArray(module.choices) || module.choices.length > 30) fail('Неверные группы выбора модуля.');
  const groups = new Set(), owners = new Map();
  const payload = module.allPayload || module.payload;
  for (const group of module.choices) {
    if (!group || !idPattern.test(group.id) || groups.has(group.id) || typeof group.title !== 'string' || !group.title.trim() ||
        typeof group.multiple !== 'boolean' || !Array.isArray(group.options) || !group.options.length || group.options.length > 100 ||
        !Array.isArray(group.default) || Object.keys(group).some(key => !['id', 'title', 'multiple', 'default', 'options'].includes(key))) fail('Неверная группа выбора.');
    groups.add(group.id);
    const options = new Set();
    for (const option of group.options) {
      if (!option || !idPattern.test(option.id) || options.has(option.id) || typeof option.title !== 'string' || !option.title.trim() ||
          !Array.isArray(option.paths) || !option.paths.length || Object.keys(option).some(key => !['id', 'title', 'paths'].includes(key))) fail('Неверный вариант группы выбора.');
      options.add(option.id);
      for (const prefix of option.paths) {
        if (typeof prefix !== 'string' || !/^(skills|rules|agents)\//.test(prefix) || prefix.includes('\\') ||
            prefix.replace(/\/$/, '').split('/').some(part => !part || part === '.' || part === '..' || /[:*?\x00-\x1f]/.test(part))) fail(`Неверный путь варианта: ${prefix}`);
        const matched = payload.filter(file => pathMatches(file.source, prefix));
        if (!matched.length) fail(`Вариант ${option.id}: путь не найден: ${prefix}`);
        for (const file of matched) {
          const owner = `${group.id}/${option.id}`;
          if (owners.has(file.source) && owners.get(file.source) !== owner) fail(`Файл входит в несколько вариантов: ${file.source}`);
          owners.set(file.source, owner);
        }
      }
    }
    if (group.default.some(id => !options.has(id)) || new Set(group.default).size !== group.default.length || (!group.multiple && group.default.length > 1)) fail(`Неверный выбор по умолчанию: ${group.id}`);
  }
  if (payload.length && owners.size === payload.length) fail('У модуля должны оставаться обязательные файлы.');
  for (const file of payload.filter(file => file.source.startsWith('skills/'))) {
    const entrypoint = file.source.split('/').slice(0, 2).join('/') + '/SKILL.md';
    if (owners.has(entrypoint) && owners.get(entrypoint) !== owners.get(file.source)) fail(`Ресурсы необязательного скилла должны входить в тот же вариант: ${file.source}`);
  }
}
export function choiceSelection(module, previous, lockedFiles = {}) {
  return Object.fromEntries((module.choices || []).map(group => {
    const known = previous?.selection?.[group.id];
    let selected = known ? known.filter(id => group.options.some(option => option.id === id)) : group.default;
    if (previous && !known) {
      const present = group.options.filter(option => (module.allPayload || module.payload).some(file =>
        option.paths.some(prefix => pathMatches(file.source, prefix)) && lockedFiles[file.target]?.module === module.id)).map(option => option.id);
      if (present.length) selected = present;
    }
    return [group.id, group.multiple ? [...selected] : selected.slice(0, 1)];
  }));
}
export function selectModule(module, selected = choiceSelection(module)) {
  if (!selected || typeof selected !== 'object' || Array.isArray(selected)) fail('Неверный выбор состава модуля.');
  const groups = module.choices || [];
  if (Object.keys(selected).some(key => !groups.some(group => group.id === key))) fail('Неизвестная группа выбора.');
  const normalized = Object.fromEntries(groups.map(group => {
    const values = selected[group.id] ?? group.default;
    if (!Array.isArray(values) || values.some(id => !group.options.some(option => option.id === id)) || new Set(values).size !== values.length || (!group.multiple && values.length > 1)) fail(`Неверный выбор: ${group.title}`);
    return [group.id, group.options.filter(option => values.includes(option.id)).map(option => option.id)];
  }));
  if (!groups.length) return module;
  const allPayload = module.allPayload || module.payload;
  return { ...module, allPayload, selectedChoices: normalized, payload: allPayload.filter(file => {
    const owner = choiceOwner(module, file.source);
    return !owner || normalized[owner.group].includes(owner.option);
  }) };
}
