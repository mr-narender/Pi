// VS Code's webview sandboxing makes the native `title` attribute tooltip
// unreliable — confirmed by hovering a real button in the real, running
// extension and waiting: no tooltip ever appeared, despite the attribute
// being present and correct (reported as "hovering help tips doesn't
// show"). Other VS Code extensions have hit the exact same thing and
// solved it the same way: render a small tooltip ourselves instead of
// relying on the browser's native one.
//
// Delegated at the document level (capture phase) so it works for every
// current AND future [title] element without needing to bind a listener
// per element on every re-render — chat.ts re-renders via morphdom, which
// reuses existing DOM nodes, so a per-element listener would need the same
// bindOnce dance every other interactive element already goes through.
// One shared listener sidesteps that entirely.
let tooltipEl: HTMLDivElement | undefined;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let activeTarget: Element | undefined;

function findTitled(start: Element | null): Element | undefined {
  let node: Element | null = start;
  while (node && node !== document.body) {
    const title = node.getAttribute('title');
    if (title) {
      return node;
    }
    node = node.parentElement;
  }
  return undefined;
}

function show(target: Element, text: string): void {
  const tip = document.createElement('div');
  tip.className = 'custom-tooltip';
  tip.textContent = text;
  document.body.appendChild(tip);
  const targetRect = target.getBoundingClientRect();
  const tipRect = tip.getBoundingClientRect();
  // data-tooltip-pos="above" flips the preferred side (used by chat-list
  // row names so the full name shows on top of the name, not covering the
  // rows below it); either preference falls back to the other side when
  // there's no room.
  const preferAbove = target.getAttribute('data-tooltip-pos') === 'above';
  let top = preferAbove ? targetRect.top - tipRect.height - 6 : targetRect.bottom + 6;
  let left = targetRect.left + targetRect.width / 2 - tipRect.width / 2;
  left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));
  if (preferAbove && top < 4) {
    top = targetRect.bottom + 6;
  } else if (!preferAbove && top + tipRect.height > window.innerHeight - 4) {
    top = targetRect.top - tipRect.height - 6;
  }
  tip.style.top = `${top}px`;
  tip.style.left = `${left}px`;
  tooltipEl = tip;
}

function hide(): void {
  clearTimeout(showTimer);
  tooltipEl?.remove();
  tooltipEl = undefined;
  activeTarget = undefined;
}

/** Call once per webview at startup. */
export function installCustomTooltips(): void {
  document.addEventListener(
    'mouseover',
    (event) => {
      const target = findTitled(event.target as Element | null);
      if (target === activeTarget) {
        return;
      }
      hide();
      if (!target) {
        return;
      }
      activeTarget = target;
      const text = target.getAttribute('title')!;
      showTimer = setTimeout(() => show(target, text), 350);
    },
    true
  );
  document.addEventListener(
    'mouseout',
    (event) => {
      const related = (event as MouseEvent).relatedTarget as Node | null;
      if (activeTarget && (!related || !activeTarget.contains(related))) {
        hide();
      }
    },
    true
  );
  // Matches native tooltip feel: any scroll or losing window focus
  // dismisses immediately rather than leaving a stale tooltip floating.
  document.addEventListener('scroll', hide, true);
  window.addEventListener('blur', hide);
}
