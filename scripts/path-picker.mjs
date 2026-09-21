import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

export function createPathPicker({ launch = spawn, platform = process.platform, startupTimeoutMs = 20_000, timeoutMs = 300_000 } = {}) {
  let active;
  const cancelled = () => ({ cancelled: true, path: null });
  return {
    close() { active?.cancel(); },
    async pick(input = {}, { signal } = {}) {
      if (!['folder', 'file'].includes(input.kind)) throw new Error('Выбери папку или файл.');
      if (platform !== 'win32') throw new Error('Системный выбор пока доступен в Windows. Путь можно вставить вручную.');
      if (input.initial && (typeof input.initial !== 'string' || input.initial.length > 4000 || !path.isAbsolute(input.initial))) throw new Error('Нужен абсолютный начальный путь.');
      if (signal?.aborted) return cancelled();
      // A new user request replaces an abandoned dialog, including requests from a reloaded tab.
      active?.cancel();
      const script = fs.readFileSync(fileURLToPath(new URL('./path-picker.ps1', import.meta.url)), 'utf8');
      const command = path.join(process.env.SystemRoot || 'C:/Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      return new Promise((resolve, reject) => {
        // Fixed trusted script; user paths are data, never PowerShell code.
        const child = launch(command, ['-NoProfile', '-STA', '-Command', script], {
          windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'],
          env: { ...process.env, BRAIN_HUB_PICKER_KIND: input.kind, BRAIN_HUB_PICKER_INITIAL: input.initial || '', BRAIN_HUB_FOLDER_PICKER: fileURLToPath(new URL('./FolderPicker.cs', import.meta.url)) },
        });
        let output = '', error = '', settled = false, startupTimer, lifetimeTimer;
        const entry = { cancel: () => stop(null, cancelled()) };
        active = entry;
        const finish = (problem, value) => {
          if (settled) return;
          settled = true;
          clearTimeout(startupTimer); clearTimeout(lifetimeTimer);
          signal?.removeEventListener('abort', entry.cancel);
          if (active === entry) active = null;
          if (problem) reject(problem); else resolve(value);
        };
        const stop = (problem, value) => { if (!settled) { finish(problem, value); child.kill(); } };
        startupTimer = setTimeout(() => stop(new Error('Окно выбора не появилось. Нажми «Выбрать папку» или «Выбрать SKILL.md» ещё раз.')), startupTimeoutMs);
        lifetimeTimer = setTimeout(() => stop(new Error('Выбор пути отменён по времени. Открой окно заново.')), timeoutMs);
        signal?.addEventListener('abort', entry.cancel, { once: true });
        child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
        child.stdout.on('data', chunk => {
          output = (output + chunk).slice(-16000);
          if (output.split(/\r?\n/).some(line => line.trim() === '{"ready":true}')) clearTimeout(startupTimer);
        });
        child.stderr.on('data', chunk => { error = (error + chunk).slice(-3000); });
        child.on('error', error => stop(error));
        child.on('close', code => {
          try {
            if (code !== 0) throw new Error(`Не удалось открыть окно выбора. ${error.trim()}`);
            const result = JSON.parse(output.replace(/^\uFEFF/, '').trim().split(/\r?\n/).at(-1));
            if (typeof result.cancelled !== 'boolean' || (!result.cancelled && (typeof result.path !== 'string' || !path.isAbsolute(result.path)))) throw new Error('Окно выбора не вернуло путь.');
            finish(null, { cancelled: result.cancelled, path: result.cancelled ? null : result.path });
          } catch (error) { finish(error); }
        });
      });
    },
  };
}
