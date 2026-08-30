import type { UiKey } from '../core/i18n';
import { onLangChange, t } from '../state';

const STORAGE_KEY = 'blocksmith.onboarding.v1';
const OPEN_EVENT = 'bs-open-onboarding';

const STEPS: readonly { eyebrow: UiKey; title: UiKey; body: UiKey; hint: UiKey }[] = [
  {
    eyebrow: 'onboarding.step1.eyebrow',
    title: 'onboarding.step1.title',
    body: 'onboarding.step1.body',
    hint: 'onboarding.step1.hint',
  },
  {
    eyebrow: 'onboarding.step2.eyebrow',
    title: 'onboarding.step2.title',
    body: 'onboarding.step2.body',
    hint: 'onboarding.step2.hint',
  },
  {
    eyebrow: 'onboarding.step3.eyebrow',
    title: 'onboarding.step3.title',
    body: 'onboarding.step3.body',
    hint: 'onboarding.step3.hint',
  },
];

const LABELS = {
  dialog: 'onboarding.dialog',
  skip: 'onboarding.skip',
  next: 'onboarding.next',
  start: 'onboarding.start',
  progress: 'onboarding.progress',
} as const satisfies Record<string, UiKey>;

export interface OnboardingHandle {
  open: () => void;
  close: () => void;
  isVisible: () => boolean;
}

export function initOnboarding(storage: Storage = localStorage): OnboardingHandle {
  const root = document.createElement('div');
  root.id = 'onboarding';
  root.hidden = true;
  root.setAttribute('role', 'dialog');
  root.setAttribute('aria-modal', 'true');
  document.body.appendChild(root);

  let step = 0;
  function remember(): void {
    try {
      storage.setItem(STORAGE_KEY, 'done');
    } catch {
      // Storage can be unavailable in private browsing. Closing should still work.
    }
  }

  function setVisible(visible: boolean, persist = false): void {
    root.hidden = !visible;
    if (persist) remember();
    if (visible) {
      render();
      root.querySelector<HTMLButtonElement>('.onboarding-next')?.focus();
    }
  }

  function render(): void {
    const current = STEPS[step]!;
    const isLast = step === STEPS.length - 1;
    root.setAttribute('aria-label', t(LABELS.dialog));
    root.innerHTML = '';

    const card = document.createElement('section');
    card.className = 'onboarding-card';

    const top = document.createElement('div');
    top.className = 'onboarding-top';
    const eyebrow = document.createElement('span');
    eyebrow.className = 'onboarding-eyebrow';
    eyebrow.textContent = t(current.eyebrow);
    const skip = document.createElement('button');
    skip.className = 'onboarding-skip';
    skip.type = 'button';
    skip.textContent = t(LABELS.skip);
    skip.addEventListener('click', () => setVisible(false, true));
    top.append(eyebrow, skip);

    const visual = document.createElement('div');
    visual.className = 'onboarding-visual';
    visual.setAttribute('aria-hidden', 'true');
    visual.innerHTML = `<span>${step + 1}</span>`;

    const title = document.createElement('h2');
    title.className = 'onboarding-title';
    title.textContent = t(current.title);
    const body = document.createElement('p');
    body.className = 'onboarding-body';
    body.textContent = t(current.body);
    const hint = document.createElement('p');
    hint.className = 'onboarding-hint';
    hint.textContent = t(current.hint);

    const footer = document.createElement('div');
    footer.className = 'onboarding-footer';
    const dots = document.createElement('div');
    dots.className = 'onboarding-dots';
    dots.setAttribute('aria-label', `${t(LABELS.progress)} ${step + 1} / ${STEPS.length}`);
    for (let index = 0; index < STEPS.length; index += 1) {
      const dot = document.createElement('span');
      if (index === step) dot.className = 'is-current';
      dots.appendChild(dot);
    }
    const next = document.createElement('button');
    next.className = 'onboarding-next';
    next.type = 'button';
    next.textContent = t(isLast ? LABELS.start : LABELS.next);
    next.addEventListener('click', () => {
      if (isLast) {
        setVisible(false, true);
        return;
      }
      step += 1;
      render();
      root.querySelector<HTMLButtonElement>('.onboarding-next')?.focus();
    });
    footer.append(dots, next);
    card.append(top, visual, title, body, hint, footer);
    root.appendChild(card);
  }

  const handle: OnboardingHandle = {
    open: () => {
      step = 0;
      setVisible(true);
    },
    close: () => setVisible(false, true),
    isVisible: () => !root.hidden,
  };

  onLangChange(() => {
    if (!root.hidden) render();
  });
  window.addEventListener(OPEN_EVENT, handle.open);
  root.addEventListener('click', (event) => {
    if (event.target === root) handle.close();
  });

  let seen = false;
  try {
    seen = storage.getItem(STORAGE_KEY) === 'done';
  } catch {
    // Treat unavailable storage as a first visit.
  }
  if (!seen && !window.matchMedia('(max-width: 960px)').matches) handle.open();

  return handle;
}
