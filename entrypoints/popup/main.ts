import { SECTIONS, optionKey, type Feature, type Option } from '@/lib/features';
import { STORE_KEY, resolve, type Settings } from '@/lib/settings';

const root = document.getElementById('sections')!;
const reloadBar = document.getElementById('reload')!;

let settings: Settings;

async function save(key: string, value: Settings[string]) {
  settings = { ...settings, [key]: value };
  await browser.storage.sync.set({ [STORE_KEY]: settings });
  reloadBar.hidden = false;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: (Node | string)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function switchInput(key: string, label: string, disabled = false) {
  const input = el('input', { type: 'checkbox', className: 'switch', checked: settings[key] === true, disabled });
  input.setAttribute('role', 'switch');
  input.setAttribute('aria-label', label);
  input.addEventListener('change', () => save(key, input.checked));
  return input;
}

function optionRow(feature: Feature, option: Option) {
  const key = optionKey(feature.id, option.id);
  const disabled = !feature.ready;
  if (option.kind === 'toggle') {
    return el('label', { className: 'option' }, el('span', {}, option.label), switchInput(key, option.label, disabled));
  }
  if (option.kind === 'select') {
    const select = el('select', { disabled });
    for (const c of option.choices) select.append(el('option', { value: c.value, textContent: c.label }));
    select.value = String(settings[key]);
    select.addEventListener('change', () => save(key, select.value));
    return el('label', { className: 'option' }, el('span', {}, option.label), select);
  }
  // List: one entry per line, saved lowercased and trimmed (Twitch logins are lowercase).
  const area = el('textarea', {
    rows: 3,
    disabled,
    placeholder: `One ${option.placeholder} per line`,
    value: (settings[key] as string[]).join('\n'),
  });
  area.addEventListener('change', () =>
    save(key, area.value.split('\n').map((s) => s.trim().toLowerCase()).filter(Boolean)),
  );
  return el('label', { className: 'option option-list' }, el('span', {}, option.label), area);
}

function featureRow(feature: Feature) {
  const title = el('span', { className: 'feature-label' }, feature.label);
  if (!feature.ready) title.append(el('span', { className: 'badge' }, 'Coming soon'));
  const toggle = switchInput(feature.id, feature.label, !feature.ready);
  const row = el(
    'div',
    { className: 'feature' + (feature.ready ? '' : ' not-ready') },
    el('label', { className: 'feature-head' }, el('span', {}, title, el('p', { className: 'desc' }, feature.description)), toggle),
  );
  if (feature.options?.length) {
    const options = el('div', { className: 'options' }, ...feature.options.map((o) => optionRow(feature, o)));
    const sync = () => options.classList.toggle('off', !toggle.checked);
    toggle.addEventListener('change', sync);
    sync();
    row.append(options);
  }
  return row;
}

function render() {
  root.replaceChildren(
    ...SECTIONS.map((section) =>
      el('section', {}, el('h2', {}, section.label), ...section.features.map(featureRow)),
    ),
  );
}

document.getElementById('reload-tabs')!.addEventListener('click', async () => {
  const tabs = await browser.tabs.query({ url: 'https://www.twitch.tv/*' });
  await Promise.all(tabs.map((t) => t.id != null && browser.tabs.reload(t.id)));
  reloadBar.hidden = true;
});

const { [STORE_KEY]: stored } = await browser.storage.sync.get(STORE_KEY);
settings = resolve(stored);
render();
