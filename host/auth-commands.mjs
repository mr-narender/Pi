import { randomUUID } from 'node:crypto';
import { serializePreferenceDefaults } from './preferences.mjs';

/** Public ModelRuntime only. Credentials and native errors never leave this closure. */
export function createAuthCommands(getSession) {
  let active;
  const providers = () =>
    getSession()
      .modelRuntime.getProviders()
      .map((p) => ({
        providerId: p.id,
        name: p.name ?? p.id,
        stored: getSession().modelRuntime.getProviderAuthStatus(p.id).source === 'stored',
        types: [
          ...(p.auth.apiKey?.login ? ['api_key'] : []),
          ...(p.auth.oauth?.login ? ['oauth'] : []),
        ],
      }));
  return {
    providers,
    async logout(providerId) {
      if (!providers().some((p) => p.providerId === providerId && p.stored))
        throw new Error('AUTH_NOT_STORED');
      await serializePreferenceDefaults(async () => {
        try {
          await getSession().modelRuntime.logout(providerId);
        } catch (error) {
          throw new Error(
            error?.name === 'CredentialSynchronizationError'
              ? 'AUTH_CHANGED_SYNC_FAILED'
              : 'AUTH_OPERATION_FAILED'
          );
        }
      });
      return { applied: true };
    },
    get busy() {
      return !!active && active.status === 'pending';
    },
    start(providerId, type) {
      if (active?.status === 'pending') throw new Error('AUTH_BUSY');
      if (!providers().some((p) => p.providerId === providerId && p.types.includes(type)))
        throw new Error('AUTH_INVALID_PROVIDER');
      const controller = new AbortController();
      const state = {
        nonce: randomUUID(),
        controller,
        events: [],
        status: 'pending',
        prompt: undefined,
      };
      active = state;
      const interaction = {
        signal: controller.signal,
        prompt: (prompt) =>
          new Promise((resolve, reject) => {
            const nonce = randomUUID();
            const abort = () => {
              if (state.prompt?.nonce === nonce) state.prompt = undefined;
              reject(new Error('AUTH_CANCELLED'));
            };
            if (controller.signal.aborted || prompt.signal?.aborted) return abort();
            controller.signal.addEventListener('abort', abort, { once: true });
            prompt.signal?.addEventListener('abort', abort, { once: true });
            state.prompt = {
              nonce,
              resolve: (value) => {
                controller.signal.removeEventListener('abort', abort);
                prompt.signal?.removeEventListener('abort', abort);
                state.prompt = undefined;
                resolve(value);
              },
              value: {
                nonce,
                type: prompt.type,
                message: prompt.message,
                placeholder: prompt.placeholder,
                ...(prompt.type === 'select' ? { options: prompt.options } : {}),
              },
            };
          }),
        notify: (event) => {
          if (state.events.length < 32) state.events.push(event);
        },
      };
      void serializePreferenceDefaults(async () => {
        try {
          controller.signal.throwIfAborted();
          // ModelRuntime.login persists/synchronizes credentials only; unlike TUI it never sets defaults/model.
          await getSession().modelRuntime.login(providerId, type, interaction);
          state.status = 'applied';
        } catch (error) {
          state.status = controller.signal.aborted
            ? 'cancelled'
            : error?.name === 'CredentialSynchronizationError'
              ? 'changed_sync_failed'
              : 'failed';
        } finally {
          state.prompt = undefined;
        }
      });
      return { nonce: state.nonce };
    },
    poll(nonce) {
      if (active?.nonce !== nonce) throw new Error('AUTH_STALE');
      return {
        status: active.status,
        events: active.events.splice(0),
        prompt: active.prompt?.value,
      };
    },
    respond(nonce, promptNonce, value) {
      if (active?.nonce !== nonce || active.status !== 'pending') throw new Error('AUTH_STALE');
      if (value === null) {
        active.controller.abort();
        return { cancelled: true };
      }
      if (active.prompt?.nonce !== promptNonce || typeof value !== 'string' || value.length > 16384)
        throw new Error('AUTH_STALE');
      active.prompt.resolve(value);
      return {};
    },
    dispose() {
      active?.controller.abort();
    },
  };
}
