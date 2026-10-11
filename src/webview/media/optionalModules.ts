import type mermaid from 'mermaid';
import type * as highlighter from '../highlight';

type Modules = { Mermaid: { default: typeof mermaid }; Highlight: typeof highlighter };
const entryScript = document.currentScript as HTMLScriptElement | null;
const pending = new Map<keyof Modules, Promise<Modules[keyof Modules]>>();

export function optionalModule<K extends keyof Modules>(name: K): Promise<Modules[K]> {
  const cached = pending.get(name);
  if (cached) return cached as Promise<Modules[K]>;
  const loaded = new Promise<Modules[K]>((resolve, reject) => {
    const script = document.createElement('script');
    const src = entryScript?.dataset[`${name.toLowerCase()}Src`];
    if (!src || !entryScript?.nonce) {
      reject(new Error(`Missing local ${name} module`));
      return;
    }
    script.src = src;
    script.nonce = entryScript.nonce;
    script.onload = () => {
      const module = (window as unknown as Record<string, Modules[K]>)[`Pi${name}`];
      if (module) resolve(module);
      else {
        script.remove();
        reject(new Error(`${name} module did not initialize`));
      }
    };
    script.onerror = () => {
      script.remove();
      reject(new Error(`Could not load ${name} module`));
    };
    document.head.append(script);
  }).catch((error) => {
    pending.delete(name);
    throw error;
  });
  pending.set(name, loaded);
  return loaded;
}
