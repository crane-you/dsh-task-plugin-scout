/**
 * Pre-install harness for dsh-task-plugin-scout.
 * Loads the bundle entry, mounts it on a fake context, and runs `plugin_scout`
 * against fixture inventories so the ranking and next steps are checked before installation.
 * Lives under test/ and is not part of the shipped plugin.
 */
import { apply, inject, name } from '../index.js';

const services = {
  pluginManager: {
    async listBundles() {
      return [
        {
          name: '@deepseek-ai/dsh-experimental-voice-input-bundle',
          official: true,
          availability: 'installation',
          version: '1.2.0',
          meta: {
            title: { en: 'Voice Input', zh: '语音输入' },
            description: { en: 'Push-to-talk dictation in the composer: speech is transcribed into the prompt.' },
          },
          enabled: false,
          installed: true,
          optional: true,
          removable: false,
          rows: [{ rowId: 'voice-input', moduleName: '@deepseek-ai/dsh-voice-input' }],
          overrides: [],
        },
        {
          name: '@deepseek-ai/dsh-office-docs-bundle',
          official: true,
          availability: 'installation',
          version: '2.0.1',
          meta: {
            title: { en: 'Office Documents' },
            description: { en: 'Create and edit Word documents, Excel spreadsheets and PowerPoint decks.' },
          },
          enabled: true,
          installed: true,
          optional: true,
          removable: false,
          rows: [{ rowId: 'office', moduleName: '@deepseek-ai/dsh-office' }],
          overrides: [],
        },
        {
          name: '@deepseek-ai/dsh-experimental-cot-translation-bundle',
          official: true,
          availability: 'missing',
          installTarget: { spec: '@deepseek-ai/dsh-experimental-cot-translation-bundle@0.3.1', version: '0.3.1' },
          meta: { title: { en: 'Reasoning Translation' }, description: { en: 'Translates the model reasoning stream into the user language.' } },
          enabled: false,
          installed: false,
          optional: true,
          removable: false,
          rows: [],
          overrides: [],
        },
      ];
    },
    async listPlugins() {
      return [
        { entryId: 'e1', moduleName: '@deepseek-ai/dsh-tool-web', patchId: 'tool-web', enabled: false, fiberPhase: null, meta: { title: 'Web Tools' } },
        { entryId: 'e2', moduleName: '@deepseek-ai/dsh-office', enabled: true, fiberPhase: 'active', meta: {} },
      ];
    },
  },
};

const makeContext = () => {
  const registrations = { tools: [], sections: [] };
  const ctx = {
    effect(fn) {
      const disposer = fn();
      return typeof disposer === 'function' ? disposer : () => {};
    },
    get: (key) => services[key],
    tools: { register: (definition) => (registrations.tools.push(definition), () => {}) },
    systemPrompt: { section: (section) => (registrations.sections.push(section), () => {}) },
  };
  return { ctx, registrations };
};

const { ctx, registrations } = makeContext();

apply(ctx, undefined);

console.log('exports:', { name, inject });
console.log('registered tools:', registrations.tools.map((tool) => tool.name));
console.log('registered sections:', registrations.sections.map((section) => `${section.name}@${section.order}`));
console.log('');

const tool = registrations.tools[0];
const signal = new AbortController().signal;

for (const task of ['帮我把这份 Excel 表格做成图表报告', '开会录音转成文字纪要', 'zzzz qqqq']) {
  const value = await tool.execute({ task, limit: 4 }, { signal });
  console.log('='.repeat(72));
  console.log(tool.output.render({ task }, value)[0].text);
  console.log('-- coverage:', value.coverage, '| scanned:', value.scanned);
  console.log('');
}

const empty = await tool.execute({ task: '录音转写', includeActive: false }, { signal });
console.log('includeActive:false →', empty.recommendations.map((r) => `${r.name}(${r.state})`).join(', ') || '(none)');

try {
  await tool.execute({ task: '   ' }, { signal });
  console.log('empty task → NO ERROR (unexpected)');
} catch (error) {
  console.log('empty task → threw:', error.message);
}

const section = registrations.sections[0];
console.log('');
console.log('prompt section text length:', section.text.length, '| interpolate:', section.interpolate);
console.log('prompt section head:', JSON.stringify(section.text.slice(0, 90)));

// Row configuration path: promptHint disables the section, limit becomes the call default.
const configured = makeContext();
apply(configured.ctx, { promptHint: false, limit: 2, useMarket: false, hintText: 'custom hint' });
const configuredTool = configured.registrations.tools[0];
const configuredRun = await configuredTool.execute({ task: '录音转写 voice' }, { signal });
console.log('');
console.log('with config {promptHint:false, limit:2} → sections:', configured.registrations.sections.length,
  '| tools:', configured.registrations.tools.length,
  '| default recommendations:', configuredRun.recommendations.length);

const hinted = makeContext();
apply(hinted.ctx, { hintText: 'custom hint' });
console.log('with config {hintText} → section text:', JSON.stringify(hinted.registrations.sections[0].text));