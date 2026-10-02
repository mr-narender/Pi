import type { SessionController } from '../sessions/sessionController';

interface OriginOperations {
  current?: { cancel: () => void; done: Promise<void>; pending: boolean };
  setters: Promise<void>;
}
const origins = new WeakMap<SessionController, OriginOperations>();

/** Supersede discovery/pickers immediately; serialize only mutations already started. */
export function beginModelOperation(
  controller: SessionController,
  originValid: () => boolean = () => true,
  allowBusyView = false
) {
  if (!allowBusyView) controller.assertNoManualCompaction?.();
  let origin = origins.get(controller);
  if (!origin) {
    origin = { setters: Promise.resolve() };
    origins.set(controller, origin);
  }
  origin.current?.cancel();
  let finish!: () => void;
  const done = new Promise<void>((resolve) => {
    finish = () => {
      intent.pending = false;
      resolve();
    };
  });
  const intent = { cancel: finish, done, pending: true };
  origin.current = intent;
  const state = { ...controller.snapshot?.state };
  const valid = () =>
    originValid() &&
    origin.current === intent &&
    controller.snapshot?.state.sessionId === state.sessionId &&
    controller.snapshot?.state.sessionFile === state.sessionFile;
  return {
    valid,
    finish,
    async mutate(action: () => Promise<void>) {
      const mutation = origin.setters.then(async () => {
        if (!valid()) return false;
        await action();
        return valid();
      });
      origin.setters = mutation.then(
        () => {},
        () => {}
      );
      return mutation;
    },
    async apply(provider: string, id: string) {
      const mutation = origin.setters.then(async () => {
        if (!valid()) return false;
        await controller.selectModel(provider, id);
        return valid();
      });
      origin.setters = mutation.then(
        () => {},
        () => {}
      );
      return mutation;
    },
  };
}

export function hasModelOperation(controller: SessionController): boolean {
  return origins.get(controller)?.current?.pending === true;
}

export function cancelModelOperations(controller: SessionController): void {
  const origin = origins.get(controller);
  origin?.current?.cancel();
  if (origin) origin.current = undefined;
}

export async function waitForModelOperations(controller: SessionController): Promise<void> {
  const session = { ...controller.snapshot.state };
  const origin = origins.get(controller);
  while (origin) {
    const intent = origin.current;
    await intent?.done;
    await origin.setters;
    if (
      controller.snapshot.state.sessionId !== session.sessionId ||
      controller.snapshot.state.sessionFile !== session.sessionFile
    ) {
      throw new Error('The originating chat changed; prompt cancelled.');
    }
    if (intent === origin.current) return;
  }
}
