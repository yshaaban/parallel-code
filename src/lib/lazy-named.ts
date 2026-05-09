import { lazy, type Component } from 'solid-js';

type LazyNamedComponent<TModule, TKey extends keyof TModule> =
  TModule[TKey] extends Component<infer TProps> ? Component<TProps> : never;

export function lazyNamed<TModule, TKey extends keyof TModule>(
  loadModule: () => Promise<TModule>,
  key: TKey,
): LazyNamedComponent<TModule, TKey> {
  return lazy(async () => {
    const module = await loadModule();
    return {
      default: module[key] as LazyNamedComponent<TModule, TKey>,
    };
  }) as LazyNamedComponent<TModule, TKey>;
}
