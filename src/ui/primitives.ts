export type ButtonVariant = 'default' | 'icon' | 'danger' | 'primary';

export interface ButtonOptions {
  label: string;
  ariaLabel?: string;
  icon?: SVGSVGElement;
  title?: string;
  className?: string;
  variant?: ButtonVariant;
  pressed?: boolean;
  disabled?: boolean;
  onClick?: (event: MouseEvent) => void;
}

function classes(...values: Array<string | undefined | false>): string {
  return values.filter(Boolean).join(' ');
}

/**
 * Toggle/button state only. Tabs use `aria-selected` and a dedicated component
 * contract; they must not reuse this pressed-state API.
 */
export function setButtonPressed(button: HTMLButtonElement, pressed: boolean): void {
  button.dataset.pressed = String(pressed);
  button.setAttribute('aria-pressed', String(pressed));
}

export function createButton(options: ButtonOptions): HTMLButtonElement {
  const button = document.createElement('button');
  const variant = options.variant ?? 'default';
  button.type = 'button';
  button.className = classes(variant === 'icon' ? 'bs-icon-button' : 'bs-button', options.className);
  button.textContent = options.label;
  if (options.icon) button.prepend(options.icon);
  if (options.ariaLabel) button.setAttribute('aria-label', options.ariaLabel);
  button.disabled = options.disabled ?? false;
  if (options.title) button.title = options.title;
  if (options.pressed !== undefined) setButtonPressed(button, options.pressed);
  if (variant === 'danger' || variant === 'primary') button.dataset.variant = variant;
  if (options.onClick) button.addEventListener('click', options.onClick);
  return button;
}

export interface InputOptions {
  type?: 'text' | 'number';
  value?: string;
  placeholder?: string;
  className?: string;
  ariaLabel?: string;
}

export function createInput(options: InputOptions = {}): HTMLInputElement {
  const input = document.createElement('input');
  input.type = options.type ?? 'text';
  input.className = classes('bs-input', options.className);
  if (options.value !== undefined) input.value = options.value;
  if (options.placeholder) input.placeholder = options.placeholder;
  if (options.ariaLabel) input.setAttribute('aria-label', options.ariaLabel);
  return input;
}

export function createDivider(className?: string): HTMLDivElement {
  const divider = document.createElement('div');
  divider.className = classes('bs-divider', className);
  divider.setAttribute('role', 'separator');
  return divider;
}

export interface TabOption<T extends string> {
  id: T;
  label: string;
  controls: string;
}

export interface TabListOptions<T extends string> {
  label: string;
  tabs: readonly TabOption<T>[];
  selected: T;
  className?: string;
  onSelect: (id: T) => void;
}

/**
 * Tabs are a distinct interaction contract from pressed buttons.
 *
 * The active tab is the only tab in the keyboard order. Arrow keys, Home, and
 * End move selection and focus together; panels are linked through
 * aria-controls / aria-labelledby by the caller.
 */
export function createTabList<T extends string>(options: TabListOptions<T>): HTMLDivElement {
  const list = document.createElement('div');
  list.className = classes('bs-tabs', options.className);
  list.setAttribute('role', 'tablist');
  list.setAttribute('aria-label', options.label);

  const buttons = options.tabs.map((tab) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `${tab.controls}-tab`;
    button.textContent = tab.label;
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-controls', tab.controls);
    button.setAttribute('aria-selected', String(tab.id === options.selected));
    button.tabIndex = tab.id === options.selected ? 0 : -1;
    button.addEventListener('click', () => options.onSelect(tab.id));
    list.appendChild(button);
    return button;
  });

  list.addEventListener('keydown', (event) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (current < 0) return;
    event.preventDefault();
    let next = current;
    if (event.key === 'ArrowLeft') next = (current - 1 + buttons.length) % buttons.length;
    if (event.key === 'ArrowRight') next = (current + 1) % buttons.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = buttons.length - 1;
    const tab = options.tabs[next];
    if (!tab) return;
    options.onSelect(tab.id);
    // Even if onSelect re-renders the tablist itself, still move focus to the new active tab.
    queueMicrotask(() => document.getElementById(`${tab.controls}-tab`)?.focus());
  });

  return list;
}
